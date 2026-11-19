"""Ponte: captura a janela do chiaki-ng -> WebRTC -> navegador.

Entrada do navegador chega por DataChannel JSON e vira um controle virtual
X360 no ViGEm Bus, que o chiaki-ng encaminha ao PS5.
"""
import asyncio
import ctypes
import ctypes.wintypes as wt
import json
import math
import os
import queue
import re
import socket
import subprocess
import threading
import time
from fractions import Fraction

import aiohttp
import av
import numpy as np
from aiohttp import web
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCConfiguration,
    RTCIceServer,
    VideoStreamTrack,
    AudioStreamTrack,
    RTCRtpSender,
    RTCRtpCodecParameters,
)
from aiortc.rtcrtpparameters import RTCRtcpFeedback
from vgamepad import VX360Gamepad, XUSB_BUTTON
from windows_capture import WindowsCapture

import aiortc.rtcrtpsender as _rtcrtpsender
from aiortc.codecs import CODECS
from aiortc.codecs.h264 import H264Encoder, PACKET_MAX
from aiortc.mediastreams import VIDEO_TIME_BASE, convert_timebase

# Timer do Windows em 1ms: sem isso asyncio.sleep(33ms) dorme ~45ms e o
# pacing dos tracks limita a produção a ~21fps em vez de 30.
try:
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass

AGENT_HOST = os.environ.get("AGENT_HOST", "127.0.0.1")
AGENT_PORT = int(os.environ.get("AGENT_PORT", "3001"))
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
STUN_URLS = os.environ.get("STUN_URLS", "stun:stun.l.google.com:19302").split(",")
TURN_URL = os.environ.get("TURN_URL", "")
TURN_USER = os.environ.get("TURN_USER", "")
TURN_PASS = os.environ.get("TURN_PASS", "")
PS5_HOST = os.environ.get("PS5_HOST", "192.168.0.100")
PS5_NICKNAME = os.environ.get("PS5_NICKNAME", "PS5-XXX")
PS5_REGISTKEY = os.environ.get("PS5_REGISTKEY", "<PS5_REGISTKEY>")
CHIAKI_EXE = os.environ.get("CHIAKI_EXE", r"C:\chiaki-ng-Win\chiaki.exe")

FPS = 30
# Jogador direto: alvo 20 Mbps (rede dedicada aguenta — pedido do operador).
# O congestion control ainda pode baixar se a estimativa despencar, mas o
# teto/ponto de partida é 20M.
VIDEO_BITRATE = 20_000_000
VIDEO_BITRATE_MAX = 20_000_000
# Cap FIXO do relay público (720p30 pra espectadores). O perfil de
# qualidade do jogador era aplicado globalmente: "lite" derrubava a live
# pública junto e "auto" deixava subir até 10M na LAN pro mediamtx.
RELAY_BITRATE_CAP = 3_000_000
# Perfis de qualidade enviados pelo viewer ({type:'video-pref', p:name}).
# "auto" segue o controle de congestão do encoder; os demais fixam um teto.
VIDEO_PROFILES = {"smooth": 4_000_000, "auto": None, "detail": 8_000_000, "data": 2_500_000, "lite": 1_800_000}
VIDEO_RES = {"lite": (1280, 720)}
_active_profile = {"name": "auto"}


def set_video_profile(name):
    if name in VIDEO_PROFILES and name != _active_profile["name"]:
        _active_profile["name"] = name
        print(f"video profile -> {name}", flush=True)


def effective_res():
    return VIDEO_RES.get(_active_profile["name"])
def effective_bitrate(cap):
    """Teto efetivo: perfil do viewer limitado pelo bitrate de congestão."""
    profile = VIDEO_PROFILES.get(_active_profile["name"])
    return min(profile, cap) if profile is not None else cap


def _authorized(request):
    if not AGENT_TOKEN:
        return request.remote == "127.0.0.1"
    return request.headers.get("Authorization", "") == f"Bearer {AGENT_TOKEN}"


class HwH264Encoder(H264Encoder):
    """H264Encoder do aiortc usando h264_nvenc (NVENC, baixa latência)
    em vez de libx264."""

    CODEC_NAME = "h264_nvenc"

    def _encode_frame(self, frame, force_keyframe):
        if self.codec and (
            frame.width != self.codec.width
            or frame.height != self.codec.height
            or abs(self.target_bitrate - self.codec.bit_rate) / self.codec.bit_rate > 0.1
        ):
            self.buffer_data = b""
            self.buffer_pts = None
            self.codec = None

        if force_keyframe:
            frame.pict_type = av.video.frame.PictureType.I
        else:
            frame.pict_type = av.video.frame.PictureType.NONE

        if self.codec is None:
            self.codec = av.CodecContext.create(self.CODEC_NAME, "w")
            self.codec.width = frame.width
            self.codec.height = frame.height
            self.codec.bit_rate = self.target_bitrate
            self.codec.pix_fmt = "yuv420p"
            # Declarado 60fps (taxa do track do jogador). O track 30fps do
            # relay gera pts 0,2,4… nessa base — monotônico, sem problema.
            # Declarar 30 com input real de 60 faria o CBR do nvenc errar o
            # orçamento de bits por frame (2× por frame).
            self.codec.framerate = Fraction(60, 1)
            self.codec.time_base = Fraction(1, 60)
            self.codec.options = {
                "delay": "0",
                "preset": "p1",
                "tune": "ull",
                "rc": "cbr",
                # B-frames reordenam ~2 frames no encoder+decoder (~66-100ms de
                # latência embutida) — zerado, o delay de vidro cai.
                "bf": "0",
                "spatial_aq": "0",
                "temporal_aq": "0",
                # Keyframe a cada 2s: viewer WHEP novo não espera o GOP default
                # do nvenc (~8s) pra decodificar — era a "tela preta" da live.
                "g": str(FPS * 2),
            }

        data_to_send = b""
        _t0 = time.perf_counter()
        for package in self.codec.encode(frame):
            data_to_send += bytes(package)
        ENC["ms"] += (time.perf_counter() - _t0) * 1000
        ENC["n"] += 1

        if data_to_send:
            yield from self._split_bitstream(data_to_send)

    @property
    def target_bitrate(self):
        relay_cap = getattr(self, "_relay_cap", None)
        if relay_cap is not None:
            return min(self.__target_bitrate, relay_cap)
        return effective_bitrate(self.__target_bitrate)

    @target_bitrate.setter
    def target_bitrate(self, bitrate):
        # Piso 1.2M: a estimativa do receiver pode despencar num soluço
        # momentâneo (ex.: screenshot no celular) — 500k deixava 1080p ilegível.
        new = max(1_200_000, min(bitrate, VIDEO_BITRATE_MAX))
        prev = getattr(self, "_last_tb", None)
        if prev is None or abs(new - prev) > 200_000:
            print(f"encoder bitrate: estimativa {bitrate/1e6:.2f}M -> alvo {new/1e6:.2f}M", flush=True)
            self._last_tb = new
        self.__target_bitrate = new

    def __init__(self):
        super().__init__()
        self.__target_bitrate = VIDEO_BITRATE


NAL_TYPE_FU_HEVC = 49  # RFC 7798 §4.4.3 — Fragmentation Unit


class HwH265Encoder(HwH264Encoder):
    """HEVC via hevc_nvenc com packetização RTP RFC 7798.

    Chrome 136+ / Safari 18+ negociam video/H265 quando existe decoder de
    hardware. Layout difere do H.264: header NAL de 2 bytes (F|Type6|LayerId6|
    TID3) e fragmentação via FU (tipo 49) em vez de FU-A.
    VPS/SPS/PPS (tipos 32/33/34) já vêm in-band no bitstream do nvenc e saem
    como NALs simples — não há sprop-* no SDP WebRTC."""

    CODEC_NAME = "hevc_nvenc"

    @staticmethod
    def _packetize_fu(data: bytes) -> list[bytes]:
        # PayloadHdr: copia F + LayerId/TID do NAL original, Type -> 49.
        fu_ind = bytes([(data[0] & 0x81) | (NAL_TYPE_FU_HEVC << 1), data[1]])
        nal_type = (data[0] >> 1) & 0x3F
        payload = data[2:]
        available = PACKET_MAX - 3
        num = max(1, math.ceil(len(payload) / available))
        size = len(payload) // num
        larger = len(payload) % num

        out, off = [], 0
        while off < len(payload):
            n = size + (1 if larger > 0 else 0)
            larger = max(0, larger - 1)
            frag = payload[off:off + n]
            start = off == 0
            off += n
            fu_hdr = nal_type | (0x80 if start else 0) | (0x40 if off == len(payload) else 0)
            out.append(fu_ind + bytes([fu_hdr]) + frag)
        return out

    @classmethod
    def _packetize(cls, packages):
        # NAL <= 1300 sai como pacote único (inclui VPS/SPS/PPS e slices
        # pequenos); > 1300 fragmenta em FU. AP é opcional — não usado.
        out = []
        for nal in packages:
            if len(nal) > PACKET_MAX:
                out.extend(cls._packetize_fu(nal))
            else:
                out.append(nal)
        return out


class HwAV1Encoder(HwH264Encoder):
    """AV1 via av1_nvenc (RTX 40xx) com packetização RTP RFC 9364.

    O bitstream do nvenc é OBU low-overhead (cada OBU tem leb128 size). Para
    RTP (RFC 9364, formato do libwebrtc): header de agregação (Z|Y|W|N),
    temporal delimiter (tipo 2) e padding (15) removidos, e cada OBU element =
    header com has_size ZERADO + ext + payload — sem os bytes de tamanho,
    que a camada RTP transporta via LEB128/campo W. Elemento por pacote
    (W=1); OBU maior que o MTU fragmenta via flags Z/Y; N no 1o pacote de
    um keyframe que carrega sequence header (tipo 1)."""

    CODEC_NAME = "av1_nvenc"

    @staticmethod
    def _leb128(n: int) -> bytes:
        out = bytearray()
        while True:
            b = n & 0x7F
            n >>= 7
            out.append(b | (0x80 if n else 0))
            if not n:
                return bytes(out)

    @classmethod
    def _split_bitstream(cls, data: bytes):
        out = []
        i, n = 0, len(data)
        while i < n:
            h = data[i]
            typ = (h >> 3) & 0xF
            ext = (h >> 2) & 1
            hs = (h >> 1) & 1
            j = i + 1 + ext
            if hs:
                size, sh = 0, 0
                while j < n:
                    b = data[j]
                    j += 1
                    size |= (b & 0x7F) << sh
                    if b < 0x80:
                        break
                    sh += 7
            else:
                size = n - j
            end = j + size
            if typ not in (2, 15):  # temporal delimiter / padding: fora do RTP
                # element: header (has_size=0) + ext + payload — size removido
                out.append(bytes([h & 0xFD]) + data[i + 1:i + 1 + ext] + data[j:end])
            i = end
        return out

    def _packetize(self, elements):
        elements = list(elements)
        if not elements:
            return []
        out = []
        first_pkt = True
        # N = 1o pacote da coded video sequence: frame chave traz seq header
        # (tipo 1) como 1o OBU — nvenc só emite em keyframe, igual libwebrtc.
        n_flag = 0x08 if (elements[0][0] & 0x78) == 0x08 else 0
        for elem in elements:
            if len(elem) <= PACKET_MAX - 1:
                # W=1: um OBU element completo, sem campo de tamanho.
                out.append(bytes([(0x10 | (n_flag if first_pkt else 0))]) + elem)
            else:
                # Fragmento: cada pacote leva 1 elemento (W=1), Z/Y marcam
                # continuação. O elemento fragmentado é só fatia do OBU —
                # header/ext saem naturalmente no 1o fragmento.
                off = 0
                frag_max = PACKET_MAX - 1
                while off < len(elem):
                    frag = elem[off:off + frag_max]
                    off += len(frag)
                    hdr = 0x10 | (0x80 if off > len(frag) else 0) | (0x40 if off < len(elem) else 0)
                    if first_pkt:
                        hdr |= n_flag
                    out.append(bytes([hdr]) + frag)
            first_pkt = False
        return out


# Registra video/H265 no aiortc (não existe nativamente). O fmtp do answer sai
# dos parameters locais — echo do profile/tier/tx-mode do Chrome; o level-id é
# ajustado pro do offer remoto no handler /offer (RFC 7798 §7.3: level <= offer).
CODECS["video"] += [
    RTCRtpCodecParameters(
        mimeType="video/H265",
        clockRate=90000,
        payloadType=105,
        rtcpFeedback=[
            RTCRtcpFeedback(type="nack"),
            RTCRtcpFeedback(type="nack", parameter="pli"),
            RTCRtcpFeedback(type="goog-remb"),
        ],
        parameters={"profile-id": "1", "tier-flag": "0", "level-id": "123", "tx-mode": "SRST"},
    ),
    RTCRtpCodecParameters(
        mimeType="video/rtx", clockRate=90000, payloadType=106, parameters={"apt": 105}
    ),
    # AV1: RTX 40xx encoda via av1_nvenc; Chrome (inclusive Android) oferece
    # decode HW — melhor codec disponível no WebRTC mobile hoje.
    RTCRtpCodecParameters(
        mimeType="video/AV1",
        clockRate=90000,
        payloadType=107,
        rtcpFeedback=[
            RTCRtcpFeedback(type="nack"),
            RTCRtcpFeedback(type="nack", parameter="pli"),
            RTCRtcpFeedback(type="goog-remb"),
        ],
        parameters={"profile": "0"},
    ),
    RTCRtpCodecParameters(
        mimeType="video/rtx", clockRate=90000, payloadType=108, parameters={"apt": 107}
    ),
]


_orig_get_encoder = _rtcrtpsender.get_encoder


def _patched_get_encoder(codec):
    mt = codec.mimeType.lower()
    if mt == "video/av1":
        return HwAV1Encoder()
    if mt == "video/h265":
        return HwH265Encoder()
    if mt == "video/h264":
        return HwH264Encoder()
    return _orig_get_encoder(codec)


_rtcrtpsender.get_encoder = _patched_get_encoder


# Encoders nascem lazy dentro de _next_encoded_frame, sem contexto de qual
# sender/track os criou. Embrulho o método: na primeira passada de cada
# encoder, marco _relay_cap quando a track do sender é a do relay (v720p).
_orig_next_encoded = _rtcrtpsender.RTCRtpSender._next_encoded_frame


async def _next_encoded_frame(self, codec):
    out = await _orig_next_encoded(self, codec)
    enc = getattr(self, "_RTCRtpSender__encoder", None)
    if enc is not None and getattr(enc, "_cap_checked", None) is None:
        enc._cap_checked = True
        if getattr(getattr(self, "track", None), "_tag", None) == "v720p":
            enc._relay_cap = RELAY_BITRATE_CAP
    return out


_rtcrtpsender.RTCRtpSender._next_encoded_frame = _next_encoded_frame


def chiaki_pid(hwnd):
    pid = wt.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value or None


def find_chiaki_windows():
    """Lista (hwnd, rect) das janelas visíveis do chiaki.exe."""
    user32 = ctypes.windll.user32
    k32 = ctypes.windll.kernel32
    result = []

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
            ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", wt.LONG),
            ("dwFlags", wt.DWORD), ("szExeFile", ctypes.c_char * 260),
        ]

    proc = k32.CreateToolhelp32Snapshot(0x2, 0)
    pe = PROCESSENTRY32()
    pe.dwSize = ctypes.sizeof(pe)
    pids = []
    if k32.Process32First(proc, ctypes.byref(pe)):
        while True:
            if pe.szExeFile.decode(errors="ignore").lower() == "chiaki.exe":
                pids.append(pe.th32ProcessID)
            if not k32.Process32Next(proc, ctypes.byref(pe)):
                break
    k32.CloseHandle(proc)

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def enum_cb(hwnd, _):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value in pids and user32.IsWindowVisible(hwnd):
            # Janela minimizada reporta rect inválido (-32000) — restaura pra
            # contar como "chiaki aberto" em vez de lançar um novo processo.
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            rect = wt.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            if (rect.right - rect.left) > 200 and (rect.bottom - rect.top) > 200:
                result.append((hwnd, (rect.left, rect.top, rect.right, rect.bottom)))
        return True

    user32.EnumWindows(enum_cb, 0)
    return result


def find_chiaki_window():
    wins = find_chiaki_windows()
    return wins[0] if wins else (None, None)


def window_is_fullscreen(hwnd):
    """True quando a janela cobre um monitor inteiro (borderless fullscreen).
    Janela comum/maximizada retorna False — chiaki windowed engasga o pipeline."""
    user32 = ctypes.windll.user32
    rect = wt.RECT()
    if not hwnd or not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return False

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT),
                    ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

    mi = MONITORINFO()
    mi.cbSize = ctypes.sizeof(mi)
    hmon = user32.MonitorFromWindow(hwnd, 2)  # MONITOR_DEFAULTTONEAREST
    if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
        return False
    m = mi.rcMonitor
    return (rect.left <= m.left and rect.top <= m.top
            and rect.right >= m.right and rect.bottom >= m.bottom)


def _send_f11_posted(hwnd):
    """F11 via PostMessage mirado no hwnd — nunca atinge outra janela.
    (keybd_event/SendInput iria pro que tiver foco = janela do usuário.)"""
    user32 = ctypes.windll.user32
    user32.PostMessageW(hwnd, 0x0100, 0x7A, 0x00570001)  # WM_KEYDOWN F11
    user32.PostMessageW(hwnd, 0x0101, 0x7A, 0xC0570001)  # WM_KEYUP


def ensure_fullscreen(hwnd):
    """Garante que a janela do stream esteja em fullscreen. Manda UM F11
    postado por chamada — dois toggles na mesma chamada podem se cancelar."""
    if not hwnd or window_is_fullscreen(hwnd):
        return True
    if hwnd not in {w for w, _ in find_chiaki_windows()}:
        return False  # hwnd reutilizado por outra janela — não é mais chiaki
    _send_f11_posted(hwnd)
    time.sleep(1.2)
    return window_is_fullscreen(hwnd)


def chiaki_streaming(cap):
    """Stream de verdade = captura viva produzindo frames (launcher parado não conta)."""
    return bool(cap.alive and cap.latest is not None
                and time.perf_counter() - (cap.stamp or 0) < 2.5)


class ChiakiCapture:
    """Captura única da janela do chiaki-ng via Windows Graphics Capture.

    Funciona mesmo com a janela coberta por outras. O frame mais recente fica
    disponível para todos os espectadores conectados.
    """

    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init()
            return cls._instance

    def _init(self):
        self.latest = None          # numpy RGB
        self.version = 0
        self.stamp = 0.0            # perf_counter do último frame capturado
        self.hwnd = None
        self.alive = False
        self.cv = threading.Condition()
        self.cap = None
        self._bad = {}  # hwnd -> monotonic até quando pular (janela sem frames)
        self.ensure()

    def _attach(self, hwnd):
        self.hwnd = hwnd
        self.pid = chiaki_pid(hwnd)
        self.latest = None
        self.version = 0
        self.stamp = 0.0
        self.alive = True
        self.cap = WindowsCapture(
            window_hwnd=hwnd,
            cursor_capture=False,
            draw_border=False,
            # 16ms: throttle só pra não disparar a 60+fps quando a fonte
            # renderiza rápido — abaixo de 30fps o WGC entregava ~27.
            minimum_update_interval=16,
        )
        cap_obj = self.cap

        @self.cap.event
        def on_frame_arrived(frame, _ctl):
            if self.cap is not cap_obj:
                return  # captura substituída — janela errada, ignora
            try:
                arr = np.ctypeslib.as_array(frame.frame_buffer)
                # BGRA puro (memcpy ~1.6ms) — o flip BGR->RGB com fancy index
                # custava ~8ms por frame segurando o GIL e engasgava o loop.
                img = arr.reshape(frame.height, frame.width, 4).copy()
                with self.cv:
                    self.latest = img
                    self.stamp = time.perf_counter()
                    self.version += 1
                    self.cv.notify_all()
            except Exception:
                pass

        def on_closed():
            self.alive = False

        self.cap.closed_handler = on_closed
        self.cap.start_free_threaded()

    def _detach(self):
        # windows_capture não expõe stop: o thread interno continua, mas o
        # callback vira no-op (self.cap is not cap_obj) e fica ocioso.
        self.alive = False
        self.cap = None
        self.latest = None

    def _wait_fresh(self, timeout):
        """Espera >=2 frames novos — janela de launcher estática não produz."""
        deadline = time.monotonic() + timeout
        with self.cv:
            while self.alive and self.version < 2 and time.monotonic() < deadline:
                self.cv.wait(timeout=max(0.02, deadline - time.monotonic()))
            return self.version >= 2

    def ensure(self):
        """Prende na janela do chiaki que de fato produz frames (a do stream,
        não a do launcher). Viva mas parada → re-arbitra entre as candidatas."""
        if self.alive and self.latest is not None and (time.perf_counter() - self.stamp) < 4:
            return True
        if self.alive:
            self._detach()
        for hwnd, _ in find_chiaki_windows():
            if time.monotonic() < self._bad.get(hwnd, 0):
                continue
            self._attach(hwnd)
            if self._wait_fresh(1.5):
                self._bad.pop(hwnd, None)
                return True
            # 12s (não 300): uma janela no meio de transição de fullscreen
            # fica sem frames por segundos — punição longa matava a captura
            # e fazia o wake lançar chiaki duplicado.
            self._bad[hwnd] = time.monotonic() + 12
            self._detach()
        return False

    def grab(self, timeout=2.0):
        """Retorna (numpy BGRA, stamp, version) do frame mais recente."""
        deadline = time.monotonic() + timeout
        with self.cv:
            while self.latest is None and self.alive and time.monotonic() < deadline:
                self.cv.wait(timeout=max(0.05, deadline - time.monotonic()))
            return self.latest, self.stamp, self.version

    def grab_new(self, last_version, timeout=0.05):
        """Espera um frame NOVO (version > last_version) até timeout."""
        deadline = time.monotonic() + timeout
        with self.cv:
            while self.alive and self.version == last_version and time.monotonic() < deadline:
                self.cv.wait(timeout=max(0.005, deadline - time.monotonic()))
            return self.latest, self.stamp, self.version


class ChiakiWindowTrack(VideoStreamTrack):
    """Entrega frames do ChiakiCapture como VideoFrame."""

    def __init__(self, res=None, fps=None):
        super().__init__()
        self._capture = ChiakiCapture()
        self._fps = fps or FPS  # jogador 60 (captura ~55 nativa); relay 30
        tag = f"v{res[1]}p" if res else "vfull"
        base, i = tag, 2
        while tag in TRACKS:
            tag = f"{base}#{i}"
            i += 1
        self._tag = tag
        TRACKS[tag] = {"n": 0}
        self._res = res  # resolução fixa (espectadores); None = perfil global
        self._count = 0
        self._start = None
        self._last_version = -1
        self._frame = None
        self._frame_stamp = 0.0
        self._t0 = None
        self._next = 0.0

    async def recv(self):
        if self._start is None:
            self._start = time.perf_counter()
            self._t0 = None
        _rt0 = time.perf_counter()
        # Grab instantâneo: com a captura mais rápida que o envio (55fps vs
        # 30), sempre pega o frame mais fresco sem custo de espera.
        frame_img, stamp, version = await asyncio.to_thread(self._capture.grab)
        if version == self._last_version and version > 0:
            # captura mais lenta que o envio: espera um frame novo pra não
            # mandar duplicata (pts real-time cobre a diferença de ritmo).
            frame_img, stamp, version = await asyncio.to_thread(
                self._capture.grab_new, self._last_version, 0.02
            )
        if version != self._last_version:
            self._frame = frame_img
            self._frame_stamp = stamp
            self._last_version = version
        if self._frame is None:
            # janela ainda não capturada: frame preto
            self._frame = np.zeros((2, 2, 3), dtype=np.uint8)
            self._frame_stamp = time.perf_counter()
        vf = av.VideoFrame.from_ndarray(self._frame, format="bgra")
        res = self._res or effective_res()
        if res and (vf.width, vf.height) != res:
            vf = vf.reformat(width=res[0], height=res[1])
        # pts = instante real da captura. Com pts por índice, qualquer atraso
        # de produção acumulava como latência de stream ("lentidão" com stats
        # boas); agora um frame atrasado pula pra posição de tempo correta.
        if self._t0 is None:
            self._t0 = self._frame_stamp
        pts = max(self._count, int((self._frame_stamp - self._t0) * self._fps + 0.5))
        self._count = pts + 1
        vf.pts = pts
        vf.time_base = Fraction(1, self._fps)
        TRACKS[self._tag]["n"] += 1
        # Pacing desacoplado do pts: avança 1/fps por envio mas nunca vai pro
        # futuro — se o pts pulou por um gap de captura, não transforma isso
        # em stall de produção (era o que derrubava o track pra ~21fps).
        now = time.perf_counter()
        if not self._next:
            self._next = now
        self._next += 1.0 / self._fps
        wait = self._next - now
        if wait < -0.1:
            self._next = now  # muito atrasado: realinha em vez de disparar rajada
        else:
            # time.sleep honra timeBeginPeriod (asyncio.sleep tem ~15ms de
            # granularidade no Windows) — pacing real de ~30fps.
            await asyncio.to_thread(time.sleep, max(0.0, wait))
        TRACKS[self._tag]["ms"] = TRACKS[self._tag].get("ms", 0) + (time.perf_counter() - _rt0) * 1000
        return vf


AUDIO_SR = 48000
AUDIO_BLOCK = 960  # 20 ms


def _boost_app_volume(pid):
    """Loopback herda o volume da sessão do app no mixer — força 100%/unmute."""
    try:
        from pycaw.pycaw import AudioUtilities
        for s in AudioUtilities.GetAllSessions():
            if s.Process and s.Process.pid == pid:
                sv = s.SimpleAudioVolume
                sv.SetMute(0, None)
                sv.SetMasterVolume(1.0, None)
                print(f"volume do app pid={pid} normalizado para 100%", flush=True)
    except Exception as exc:
        print("boost volume falhou:", repr(exc), flush=True)


class ChiakiAudioTrack(AudioStreamTrack):
    """Áudio apenas do processo chiaki.exe (WASAPI process loopback)."""

    def __init__(self, pid):
        super().__init__()
        from collections import deque
        from proctap import ProcessAudioCapture
        self._chunks = deque()
        self._pending = np.zeros(0, dtype=np.float32)
        self._lock = threading.Lock()
        self._count = 0
        self._start = None
        self._cap = ProcessAudioCapture(pid, on_data=self._on_data, resample_quality='fast')
        self._cap.start()
        threading.Thread(target=_boost_app_volume, args=(pid,), daemon=True).start()
        print(f"audio loopback pid={pid}", flush=True)

    def _on_data(self, pcm, _frames):
        with self._lock:
            self._chunks.append(pcm)
            # Backlog máx ~300ms (estéreo = 2 amostras/frame): antes era ~2s
            # e o áudio podia ficar 2s atrás do vídeo depois de qualquer engasgo.
            cap = int(AUDIO_SR * 2 * 0.3)
            while sum(len(c) for c in self._chunks) > cap and len(self._chunks) > 1:
                self._chunks.popleft()

    async def recv(self):
        if self._start is None:
            self._start = time.perf_counter()
        await asyncio.sleep(max(0, self._start + self._count * AUDIO_BLOCK / AUDIO_SR - time.perf_counter()))
        need = AUDIO_BLOCK * 2
        with self._lock:
            while self._pending.size < need and self._chunks:
                data = np.frombuffer(self._chunks.popleft(), dtype=np.float32)
                self._pending = np.concatenate([self._pending, data])
            if self._pending.size >= need:
                take = self._pending[:need]
                self._pending = self._pending[need:]
            else:
                take = np.zeros(need, dtype=np.float32)
        pcm16 = (np.clip(take, -1.0, 1.0) * 32767).astype(np.int16)
        frame = av.AudioFrame.from_ndarray(pcm16.reshape(1, -1), format="s16", layout="stereo")
        frame.sample_rate = AUDIO_SR
        frame.pts = self._count * AUDIO_BLOCK
        frame.time_base = Fraction(1, AUDIO_SR)
        self._count += 1
        return frame

    def stop(self):
        try:
            self._cap.stop()
        except Exception:
            pass
        super().stop()

# Botões no padrão Gamepad API (standard mapping):
# 0-3 face (baixo/direita/esquerda/cima), 4-5 ombros, 8-9 select/start,
# 10-11 analógicos, 12-15 D-pad. 6-7 (gatilhos) vão por valor analógico.
BUTTON_MAP = {
    0: XUSB_BUTTON.XUSB_GAMEPAD_A, 1: XUSB_BUTTON.XUSB_GAMEPAD_B,
    2: XUSB_BUTTON.XUSB_GAMEPAD_X, 3: XUSB_BUTTON.XUSB_GAMEPAD_Y,
    4: XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER, 5: XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
    8: XUSB_BUTTON.XUSB_GAMEPAD_BACK, 9: XUSB_BUTTON.XUSB_GAMEPAD_START,
    10: XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB, 11: XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
    12: XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP, 13: XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
    14: XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT, 15: XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
}
_PAD = None

# Grant de controle emitido pelo servidor: só um turno por vez.
# {"token": str|None, "expires": float(ms)} — None = sem controle.
GRANT = {"token": None, "expires": 0.0}
ACTIVE_RELAYS = set()
# Qual relay detém o controle: o token do turno vale para qualquer conexão,
# mas só UM dispositivo pode comandar o pad — o último a mandar input ativo.
CONTROL = {"relay": None}


def grant_allows(token_value):
    return (
        GRANT["token"] is not None
        and token_value == GRANT["token"]
        and time.time() * 1000 < GRANT["expires"] + 2000
    )


def frame_has_input(data):
    """Frame com comando real (eixo ou botão) — frame zerado não rouba controle."""
    try:
        if data.get("buttons"):
            return True
        return any(abs(float(data.get(k, 0) or 0)) > 0.05 for k in ("lx", "ly", "rx", "ry", "lt", "rt"))
    except (TypeError, ValueError):
        return False


def reset_all_relays():
    CONTROL["relay"] = None
    for relay in list(ACTIVE_RELAYS):
        try:
            relay.reset()
        except Exception:
            pass


async def grant_watchdog():
    while True:
        await asyncio.sleep(0.5)
        if GRANT["token"] is not None and time.time() * 1000 >= GRANT["expires"] + 2000:
            GRANT["token"] = None
            reset_all_relays()


def get_pad():
    global _PAD
    if _PAD is None:
        _PAD = VX360Gamepad()
    return _PAD


class InputRelay:
    """DataChannel -> controle virtual X360. Neutraliza ao desconectar."""

    MAX_MSG_PER_SEC = 240  # 60Hz nominal; rajadas de intervalo clumped não devem derrubar input

    def __init__(self):
        self.buttons = set()
        self.accepted = 0
        self.rejected = {}
        self.total = 0
        self.last_seq = 0
        self._window_start = time.monotonic()
        self._window_count = 0

    def stats(self):
        rej = ", ".join(f"{k}={v}" for k, v in self.rejected.items()) or "nenhum"
        return f"input ok={self.accepted} total={self.total} rejeitados: {rej}"

    def _rate_limited(self):
        now = time.monotonic()
        if now - self._window_start >= 1.0:
            self._window_start = now
            self._window_count = 0
        self._window_count += 1
        return self._window_count > self.MAX_MSG_PER_SEC

    def apply(self, data):
        """Aplica o frame; retorna True se aceito, False se inválido."""
        try:
            lx = max(-1.0, min(1.0, float(data.get("lx", 0))))
            ly = max(-1.0, min(1.0, float(data.get("ly", 0))))
            rx = max(-1.0, min(1.0, float(data.get("rx", 0))))
            ry = max(-1.0, min(1.0, float(data.get("ry", 0))))
            lt = max(0.0, min(1.0, float(data.get("lt", 0))))
            rt = max(0.0, min(1.0, float(data.get("rt", 0))))
            buttons = set(int(b) for b in data.get("buttons", []) if int(b) in BUTTON_MAP)
        except (TypeError, ValueError):
            return False
        pad = get_pad()
        for idx in self.buttons - buttons:
            pad.release_button(BUTTON_MAP[idx])
        for idx in buttons - self.buttons:
            pad.press_button(BUTTON_MAP[idx])
        self.buttons = buttons
        pad.left_joystick_float(lx, -ly)
        pad.right_joystick_float(rx, -ry)
        pad.left_trigger_float(lt)
        pad.right_trigger_float(rt)
        pad.update()
        return True

    def reset(self):
        self.buttons.clear()
        get_pad().reset()


PLAYER_PCS = set()  # conexões diretas de jogador — uma só é legítima por vez


async def offer(request):
    if not _authorized(request):
        return web.json_response({"error": "Não autorizado."}, status=401)
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "JSON inválido"}, status=400)

    capture = ChiakiCapture()
    await asyncio.to_thread(capture.ensure)
    if not capture.alive:
        return web.json_response({"error": "Janela do chiaki-ng não encontrada. Abra o Chiaki com stream ativo."}, status=503)

    ice_servers = [RTCIceServer(urls=u) for u in STUN_URLS if u]
    if TURN_URL:
        ice_servers.append(
            RTCIceServer(
                urls=[f"{TURN_URL}?transport=udp", f"{TURN_URL}?transport=tcp"],
                username=TURN_USER,
                credential=TURN_PASS,
            )
        )
    pc = RTCPeerConnection(RTCConfiguration(iceServers=ice_servers))
    # Só existe um jogador por vez — um pc anterior de /offer é sempre zumbi
    # (reconexão da mesma pessoa). Cada um encoda+envia ~60fps: fecha na hora.
    for old in list(PLAYER_PCS):
        asyncio.ensure_future(old.close())
    PLAYER_PCS.clear()
    PLAYER_PCS.add(pc)
    relay = InputRelay()
    ACTIVE_RELAYS.add(relay)

    async def cleanup(_=None):
        PLAYER_PCS.discard(pc)
        if audio_track:
            audio_track.stop()
        ACTIVE_RELAYS.discard(relay)
        if CONTROL["relay"] is relay:
            CONTROL["relay"] = None
        relay.reset()
        await pc.close()

    def _on_state_change():
        if pc.connectionState in ("failed", "closed"):
            asyncio.ensure_future(cleanup())
        elif pc.connectionState == "disconnected":
            # ICE "disconnected" pode ficar pendurado por minutos — encerra
            # se não recuperar, em vez de encodar/enviar pra um peer morto.
            async def _delayed():
                await asyncio.sleep(12)
                if pc.connectionState == "disconnected":
                    await cleanup()
            asyncio.ensure_future(_delayed())

    pc.on("connectionstatechange", lambda: _on_state_change())

    def on_datachannel(channel):
        print("datachannel recebido", flush=True)

        def on_message(message):
            relay.total += 1
            try:
                data = json.loads(message)
            except Exception:
                return
            # Preferência de qualidade não exige grant (só afeta este peer)
            if data.get("type") == "video-pref":
                set_video_profile(str(data.get("p", "")))
                return
            token = data.get("t")
            if not grant_allows(token):
                if not token:
                    reason = "sem-token"
                elif GRANT["token"] is None:
                    reason = "sem-turno-ativo"
                elif token != GRANT["token"]:
                    reason = "token-errado"
                else:
                    reason = "expirado"
                relay.rejected[reason] = relay.rejected.get(reason, 0) + 1
                return
            # Canal é unordered: descarta frames que chegaram fora de ordem
            # (um estado antigo aplicado depois do novo faz o input "travar").
            s_val = data.get("s")
            if s_val is not None:
                if s_val <= relay.last_seq:
                    relay.rejected["fora-de-ordem"] = relay.rejected.get("fora-de-ordem", 0) + 1
                    return
                relay.last_seq = s_val
            if relay._rate_limited():
                relay.rejected["rate"] = relay.rejected.get("rate", 0) + 1
                return
            # Controle por dispositivo: uma segunda aba/aparelho com o mesmo
            # token mandaria frames zerados e faria o jogo "andar e parar".
            # Só quem envia input ATIVO assume — frame zerado não rouba a vez.
            ctrl = CONTROL["relay"]
            if ctrl is not relay:
                if ctrl is None or frame_has_input(data):
                    CONTROL["relay"] = relay
                else:
                    relay.rejected["outro-controle"] = relay.rejected.get("outro-controle", 0) + 1
                    return
            t0 = time.perf_counter()
            try:
                ok = relay.apply(data)
            except Exception:
                ok = False
            proc_ms = (time.perf_counter() - t0) * 1000
            if ok:
                relay.accepted += 1
            else:
                relay.rejected["parse"] = relay.rejected.get("parse", 0) + 1
            # input-ack para o viewer medir RTT (estilo smartcast)
            seq = data.get("s")
            if seq is not None:
                try:
                    channel.send(json.dumps({
                        "type": "input-ack", "s": seq, "ok": bool(ok),
                        "p": round(proc_ms, 2),
                    }))
                except Exception:
                    pass
            if relay.total % 600 == 0:
                print(relay.stats(), flush=True)

        def on_close():
            if CONTROL["relay"] is relay:
                CONTROL["relay"] = None
            relay.reset()
            print(relay.stats(), flush=True)

        channel.on("open", lambda: print("datachannel 'input' aberto", flush=True))
        channel.on("message", on_message)
        channel.on("close", on_close)

    pc.on("datachannel", on_datachannel)
    # 60fps pro jogador: a captura nativa entrega ~55fps do PS5 — mandar só
    # 30 jogava metade fora e dobrava o staleness do frame exibido.
    pc.addTrack(ChiakiWindowTrack(fps=60))
    audio_track = None
    if capture.pid and "m=audio" in data.get("sdp", ""):
        try:
            audio_track = ChiakiAudioTrack(capture.pid)
            pc.addTrack(audio_track)
        except Exception as exc:
            print("audio track falhou:", repr(exc), flush=True)
    for transceiver in pc.getTransceivers():
        if transceiver.kind == "video":
            # H.265 primeiro: a ordem LOCAL decide o answer, não a do offer —
            # sem o sort, H264 (antes no registry) vencia mesmo com o cliente
            # ofertando H265. Quem não oferta H265 simplesmente ignora o codec.
            prefs = [
                c for c in RTCRtpSender.getCapabilities("video").codecs
                if c.mimeType.lower() in ("video/av1", "video/h265", "video/h264")
            ]
            order = {"video/av1": 0, "video/h265": 1, "video/h264": 2}
            prefs.sort(key=lambda c: order.get(c.mimeType.lower(), 9))
            transceiver.setCodecPreferences(prefs)

    sdp_in = data.get("sdp", "")
    # Echo do level-id do offer: o answer herda nossos parameters locais, e
    # RFC 7798 pede level <= ofertado (o decoder HW do cliente anuncia o dele).
    m = re.search(r"a=rtpmap:(\d+)\s+H265/90000", sdp_in)
    if m:
        lvl = re.search(rf"a=fmtp:{m.group(1)}\s+[^\r\n]*?level-id=(\d+)", sdp_in)
        for c in CODECS["video"]:
            if c.mimeType.lower() == "video/h265":
                if lvl:
                    c.parameters["level-id"] = lvl.group(1)
                print(f"h265 ofertado pelo cliente (pt={m.group(1)}, level-id={c.parameters.get('level-id')})", flush=True)
    # debug temporário: ordem real dos codecs de vídeo no offer (por que h264
    # vencia mesmo com h265 presente?)
    for line in sdp_in.splitlines():
        if line.startswith("m=video") or "H265/" in line or "H264/" in line:
            print("OFR| " + line.strip(), flush=True)

    offer_sdp = RTCSessionDescription(sdp=sdp_in, type=data.get("type", "offer"))
    try:
        await pc.setRemoteDescription(offer_sdp)
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        for t in pc.getTransceivers():
            if t.kind == "video" and t._codecs:
                LAST_CODEC["v"] = t._codecs[0].mimeType
                print(f"codec negociado: {t._codecs[0].mimeType}", flush=True)
    except Exception as exc:
        print("negociação SDP falhou:", repr(exc), flush=True)
        try:
            if audio_track:
                audio_track.stop()
            await pc.close()
        except Exception:
            pass
        return web.json_response({"error": "Falha ao negociar a sessão WebRTC."}, status=502)
    for _ in range(100):
        if pc.iceGatheringState in ("complete", "closed"):
            break
        await asyncio.sleep(0.05)
    return web.json_response({"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})


wake_state = {"waking": False, "since": 0.0}


def send_ps5_wakeup():
    pkt = (
        "WAKEUP * HTTP/1.1\r\n"
        "client-type:vr\r\n"
        "auth-type:R\r\n"
        f"user-credential:{PS5_REGISTKEY}\r\n"
        "device-type:vr\r\n"
        "model:w\r\n"
        "app-type:r\r\n\r\n"
    ).encode()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for dst in (PS5_HOST, "255.255.255.255"):
            try:
                s.sendto(pkt, (dst, 987))
            except OSError:
                pass


async def wake_routine():
    """Acorda o PS5 (pacote wakeup) e abre `chiaki stream` até frames fluírem."""
    wake_state["waking"] = True
    wake_state["since"] = time.time()
    cap = ChiakiCapture()
    proc = None
    last_wake = 0.0
    last_launch = 0.0
    launches = 0
    try:
        deadline = time.time() + 150
        while time.time() < deadline:
            await asyncio.to_thread(cap.ensure)
            if chiaki_streaming(cap):
                print("chiaki acordou: stream ativo", flush=True)
                return
            if time.time() - last_wake >= 12:
                send_ps5_wakeup()
                last_wake = time.time()
                print("ps5 wakeup enviado", flush=True)
            stream_running = proc is not None and proc.poll() is None
            if launches < 6 and (proc is None or (not stream_running and time.time() - last_launch > 15)):
                try:
                    proc = subprocess.Popen(
                        [CHIAKI_EXE, "--fullscreen", "--exit-app-on-stream-exit",
                         "stream", PS5_NICKNAME, PS5_HOST],
                        cwd=os.path.dirname(CHIAKI_EXE),
                    )
                    launches += 1
                    last_launch = time.time()
                    print(f"chiaki stream lançado ({launches})", flush=True)
                except Exception as exc:
                    print("falha ao lançar chiaki:", repr(exc), flush=True)
                    launches += 1
                    last_launch = time.time()
            await asyncio.sleep(1)
    finally:
        wake_state["waking"] = False
        print("rotina de wake encerrada", flush=True)


async def wake(request):
    if not _authorized(request):
        return web.json_response({"error": "Não autorizado."}, status=401)
    cap = ChiakiCapture()
    await asyncio.to_thread(cap.ensure)
    if chiaki_streaming(cap):
        return web.json_response({"ok": True, "streaming": True})
    if not wake_state["waking"]:
        asyncio.create_task(wake_routine())
    return web.json_response({"ok": True, "starting": True})


async def grant(request):
    if not _authorized(request):
        return web.json_response({"error": "Não autorizado."}, status=401)
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "JSON inválido"}, status=400)
    token_value = data.get("token")
    if token_value is None:
        GRANT["token"] = None
        GRANT["expires"] = 0.0
        reset_all_relays()
        print("grant revogado", flush=True)
    else:
        new_token = str(token_value)
        if GRANT["token"] != new_token:
            reset_all_relays()  # troca de turno: solta botões do jogador anterior
        GRANT["token"] = new_token
        # O relógio do server pode divergir do PC — clamp no teto local.
        GRANT["expires"] = min(float(data.get("expiresAt") or 0), time.time() * 1000 + 65_000)
        print(f"grant ativo token={GRANT['token'][:8]}… até {GRANT['expires']:.0f}", flush=True)
    return web.json_response({"ok": True})


# ---------- Publicação única p/ espectadores (MediaMTX WHIP) ----------

MTX_WHIP = os.environ.get("MTX_WHIP_URL", "http://127.0.0.1:8889/ps5/whip")


class WhipPublisher:
    """Sobe 1 stream (vídeo+áudio) pro MediaMTX; viewers leem via WHEP."""

    def __init__(self):
        self._want = False
        self._live = False   # sessão WHIP realmente estabelecida
        self._task = None
        self.pc = None
        self.audio = None

    @property
    def publishing(self):
        return self._live

    async def start(self):
        self._want = True
        if not self._task or self._task.done():
            self._task = asyncio.ensure_future(self._supervise())

    async def stop(self):
        self._want = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        await self._close()

    async def _close(self):
        self._live = False
        if self.audio:
            try:
                self.audio.stop()
            except Exception:
                pass
            self.audio = None
        if self.pc:
            try:
                await self.pc.close()
            except Exception:
                pass
            self.pc = None

    async def _supervise(self):
        while self._want:
            try:
                await self._session()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print("whip erro:", repr(e), flush=True)
            await self._close()
            if self._want:
                await asyncio.sleep(6)

    async def _session(self):
        cap = ChiakiCapture()
        await asyncio.to_thread(cap.ensure)
        if not cap.alive:
            raise RuntimeError("janela do chiaki não encontrada")
        pc = RTCPeerConnection()  # LAN com o mediamtx: host candidates bastam
        self.pc = pc
        # Espectadores em 720p: metade do custo de encode no loop do agente
        # (o RTC direto do jogador continua seguindo o perfil dele).
        pc.addTrack(ChiakiWindowTrack(res=(1280, 720)))
        for t in pc.getTransceivers():
            if t.kind == "video":
                # Força H264 → nvenc (GPU). Sem isso cai em VP8/libvpx (CPU).
                t.setCodecPreferences([
                    c for c in RTCRtpSender.getCapabilities("video").codecs
                    if c.mimeType.lower() == "video/h264"
                ])
        pid = getattr(cap, "pid", None) or chiaki_pid(cap.hwnd)
        if pid:
            try:
                self.audio = ChiakiAudioTrack(pid)
                pc.addTrack(self.audio)
            except Exception as e:
                print("whip: áudio indisponível:", repr(e), flush=True)
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        # WHIP clássico: POST com todos os candidatos embutidos no SDP.
        for _ in range(50):
            if pc.iceGatheringState == "complete":
                break
            await asyncio.sleep(0.1)
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                MTX_WHIP,
                data=pc.localDescription.sdp.encode(),
                headers={"Content-Type": "application/sdp"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as r:
                if r.status not in (200, 201):
                    raise RuntimeError(f"whip HTTP {r.status}: {(await r.text())[:120]}")
                answer = await r.text()
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        self._live = True
        print("whip: publicando no mediamtx", flush=True)
        while self._want and pc.iceConnectionState not in ("failed", "closed"):
            await asyncio.sleep(2)
        print(f"whip: sessão encerrou (want={self._want} ice={pc.iceConnectionState})", flush=True)


PUBLISHER = WhipPublisher()


# ---------- Diagnóstico: taxa de captura x produção, lag do loop ----------
TRACKS = {}
ENC = {"n": 0, "ms": 0.0}
LOOP_LAG = {"max": 0.0}


async def loop_lag():
    while True:
        t0 = time.perf_counter()
        await asyncio.sleep(0.1)
        drift = time.perf_counter() - t0 - 0.1
        if drift > LOOP_LAG["max"]:
            LOOP_LAG["max"] = drift


LAST_CODEC = {"v": "-"}  # codec do RTC direto (h264/h265) — vai no diag


async def diag_stats():
    cap = ChiakiCapture()
    prev_v, prev_t = cap.version, time.perf_counter()
    prev_n = {}
    while True:
        await asyncio.sleep(10)
        now = time.perf_counter()
        parts = [f"capture={(cap.version - prev_v) / (now - prev_t):.1f}fps codec={LAST_CODEC['v']}"]
        for tag, st in TRACKS.items():
            pn, pt = prev_n.get(tag, (st["n"], prev_t))
            produced = st["n"] - pn
            recv_ms = st.get("ms", 0) / produced if produced else 0
            parts.append(f"{tag}={produced / (now - pt):.1f}fps({recv_ms:.0f}ms)")
            prev_n[tag] = (st["n"], now)
            st["ms"] = 0
        parts.append(f"looplag={LOOP_LAG['max'] * 1000:.0f}ms")
        LOOP_LAG["max"] = 0.0
        if ENC["n"]:
            parts.append(f"enc={ENC['ms'] / ENC['n']:.1f}ms")
            ENC["n"] = ENC["ms"] = 0
        prev_v, prev_t = cap.version, now
        print("diag " + " ".join(parts), flush=True)


_fs_last = {"at": 0.0}  # throttle do re-F11


async def publish_supervisor():
    """Stream pública sempre ativa enquanto o chiaki estiver conectado ao PS5.

    A janela é a fonte da verdade: apareceu → publica; sumiu → derruba.
    """
    while True:
        await asyncio.sleep(2)
        try:
            # Chiaki windowed engasga o vídeo no celular — força fullscreen na
            # janela do stream sempre que ela sair desse estado. O F11 é só
            # PostMessage no hwnd capturado (pertencente ao chiaki.exe): nunca
            # atinge janelas de terceiros neste PC de trabalho.
            cap = ChiakiCapture()
            if cap.hwnd and not window_is_fullscreen(cap.hwnd) \
                    and time.time() - _fs_last.get("at", 0) > 10:
                _fs_last["at"] = time.time()
                hwnd = cap.hwnd
                if await asyncio.to_thread(ensure_fullscreen, hwnd):
                    if hwnd == cap.hwnd:
                        print(f"chiaki fullscreen reativado hwnd={hwnd}", flush=True)
            # Sessão WGC morre quando a janela troca de visual (ex.: transição
            # de fullscreen). ensure re-arbitra e reconecta a captura — sem isso
            # o stream ficava morto até chegar um /offer.
            want = bool((await asyncio.to_thread(find_chiaki_window))[0])
            if want:
                await asyncio.to_thread(cap.ensure)
            if want and not PUBLISHER._want:
                await PUBLISHER.start()
            elif not want and PUBLISHER._want:
                await PUBLISHER.stop()
        except Exception as exc:
            print("publish supervisor:", repr(exc), flush=True)


async def publish(request):
    if not _authorized(request):
        return web.json_response({"error": "Não autorizado."}, status=401)
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "JSON inválido"}, status=400)
    if data.get("on"):
        await PUBLISHER.start()
    else:
        await PUBLISHER.stop()
    return web.json_response({"ok": True, "publishing": PUBLISHER.publishing})


def make_app():
    app = web.Application()
    async def _startup(_app):
        asyncio.ensure_future(grant_watchdog())
        asyncio.ensure_future(publish_supervisor())
        asyncio.ensure_future(loop_lag())
        asyncio.ensure_future(diag_stats())

    app.on_startup.append(_startup)
    app.router.add_post("/offer", offer)
    app.router.add_post("/grant", grant)
    app.router.add_post("/wake", wake)
    app.router.add_post("/publish", publish)
    # find_chiaki_window enumera janelas do Win32 — fora do loop pra não
    # bloquear o pipeline de vídeo a cada poll do servidor.
    async def health(_r):
        cap = ChiakiCapture()
        await asyncio.to_thread(cap.ensure)
        return web.json_response({
            "ok": True,
            "streaming": chiaki_streaming(cap),
            "waking": wake_state["waking"],
            "publishing": PUBLISHER.publishing,
        })
    app.router.add_get("/health", health)
    return app


if __name__ == "__main__":
    hwnd, _ = find_chiaki_window()
    if hwnd:
        print(f"chiaki-ng encontrado: hwnd={hwnd}")
    else:
        print("chiaki-ng não encontrado; o agente tentará de novo a cada /offer")
    web.run_app(make_app(), host=AGENT_HOST, port=AGENT_PORT, print=None)
