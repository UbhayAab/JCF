"""
Custom QR Code Generator
========================
A feature-rich QR code generator with Tkinter UI.
Supports custom patterns, gradients, logo embedding,
error correction, and footer text.
"""

import tkinter as tk
from tkinter import ttk, colorchooser, filedialog, messagebox
import qrcode
from qrcode.constants import (
    ERROR_CORRECT_L,
    ERROR_CORRECT_M,
    ERROR_CORRECT_Q,
    ERROR_CORRECT_H,
)
from PIL import Image, ImageDraw, ImageFont, ImageTk, ImageFilter
import math
import os
import sys

# ─────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────
MODULE_STYLES = [
    "Square",
    "Rounded",
    "Dots",
    "Diamond",
    "Star",
    "Cross",
    "Vertical Bars",
    "Horizontal Bars",
]
EYE_STYLES = ["Square", "Rounded", "Circle", "Diamond"]
COLOR_MODES = ["Solid", "Linear Gradient", "Radial Gradient"]
GRADIENT_DIRS = ["Vertical", "Horizontal", "Diagonal"]
ERROR_LEVELS = {
    "L  (~7%)": ERROR_CORRECT_L,
    "M  (~15%)": ERROR_CORRECT_M,
    "Q  (~25%)": ERROR_CORRECT_Q,
    "H  (~30%)": ERROR_CORRECT_H,
}
PREVIEW_SIZE = 420
EXPORT_MODULE = 20  # pixels per module for full-res export


# ─────────────────────────────────────────────
# Drawing helpers
# ─────────────────────────────────────────────
def _lerp_color(c1, c2, t):
    """Linearly interpolate between two RGB tuples."""
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
    )


def _make_gradient(width, height, color1, color2, direction="Vertical"):
    """Create a gradient image from color1 to color2 using direct pixel access."""
    img = Image.new("RGB", (width, height))
    pixels = img.load()

    if direction == "Vertical":
        for y in range(height):
            t = y / max(height - 1, 1)
            c = _lerp_color(color1, color2, t)
            for x in range(width):
                pixels[x, y] = c
    elif direction == "Horizontal":
        for x in range(width):
            t = x / max(width - 1, 1)
            c = _lerp_color(color1, color2, t)
            for y in range(height):
                pixels[x, y] = c
    else:  # Diagonal
        denom = max(width + height - 2, 1)
        for y in range(height):
            for x in range(width):
                t = (x + y) / denom
                pixels[x, y] = _lerp_color(color1, color2, t)

    return img


def _make_radial_gradient(width, height, color1, color2):
    """Radial gradient: color1 at centre, color2 at edges."""
    img = Image.new("RGB", (width, height))
    cx, cy = width / 2.0, height / 2.0
    max_dist = math.sqrt(cx * cx + cy * cy)
    pixels = img.load()

    for y in range(height):
        for x in range(width):
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            t = min(dist / max_dist, 1.0)
            pixels[x, y] = _lerp_color(color1, color2, t)

    return img


def _hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i: i + 2], 16) for i in (0, 2, 4))


# ─────────────────────────────────────────────
# Module shape painters
# ─────────────────────────────────────────────
def _draw_module(draw, x, y, size, style, color):
    """Draw a single data module with the given style."""
    margin = max(1, size // 10)
    if style == "Square":
        draw.rectangle([x, y, x + size - 1, y + size - 1], fill=color)
    elif style == "Rounded":
        r = size // 3
        draw.rounded_rectangle([x, y, x + size - 1, y + size - 1], radius=r, fill=color)
    elif style == "Dots":
        cx, cy = x + size // 2, y + size // 2
        radius = (size - margin * 2) // 2
        draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color)
    elif style == "Diamond":
        cx, cy = x + size // 2, y + size // 2
        h = size // 2 - margin
        draw.polygon([(cx, cy - h), (cx + h, cy), (cx, cy + h), (cx - h, cy)], fill=color)
    elif style == "Star":
        cx, cy = x + size // 2, y + size // 2
        outer = size // 2 - margin
        inner = outer // 2
        points = []
        for i in range(5):
            angle = math.radians(-90 + i * 72)
            points.append((cx + outer * math.cos(angle), cy + outer * math.sin(angle)))
            angle2 = math.radians(-90 + i * 72 + 36)
            points.append((cx + inner * math.cos(angle2), cy + inner * math.sin(angle2)))
        draw.polygon(points, fill=color)
    elif style == "Cross":
        arm = max(1, size // 4)
        draw.rectangle([x + arm, y, x + size - arm - 1, y + size - 1], fill=color)
        draw.rectangle([x, y + arm, x + size - 1, y + size - arm - 1], fill=color)
    elif style == "Vertical Bars":
        bar_w = max(1, size // 3)
        cx = x + (size - bar_w) // 2
        draw.rectangle([cx, y, cx + bar_w - 1, y + size - 1], fill=color)
    elif style == "Horizontal Bars":
        bar_h = max(1, size // 3)
        cy = y + (size - bar_h) // 2
        draw.rectangle([x, cy, x + size - 1, cy + bar_h - 1], fill=color)


def _draw_eye(draw, x, y, size, style, color, bg_color):
    """Draw one finder pattern (7×7 modules) with the given eye style."""
    outer = size * 7
    inner_offset = size
    inner = size * 5
    core_offset = size * 2
    core = size * 3

    if style == "Square":
        draw.rectangle([x, y, x + outer - 1, y + outer - 1], fill=color)
        draw.rectangle(
            [x + inner_offset, y + inner_offset,
             x + inner_offset + inner - 1, y + inner_offset + inner - 1],
            fill=bg_color,
        )
        draw.rectangle(
            [x + core_offset, y + core_offset,
             x + core_offset + core - 1, y + core_offset + core - 1],
            fill=color,
        )
    elif style == "Rounded":
        r = size
        draw.rounded_rectangle([x, y, x + outer - 1, y + outer - 1], radius=r * 2, fill=color)
        draw.rounded_rectangle(
            [x + inner_offset, y + inner_offset,
             x + inner_offset + inner - 1, y + inner_offset + inner - 1],
            radius=r, fill=bg_color,
        )
        draw.rounded_rectangle(
            [x + core_offset, y + core_offset,
             x + core_offset + core - 1, y + core_offset + core - 1],
            radius=r, fill=color,
        )
    elif style == "Circle":
        cx_c = x + outer // 2
        cy_c = y + outer // 2
        ro = outer // 2
        ri = inner // 2
        rc = core // 2
        draw.ellipse([cx_c - ro, cy_c - ro, cx_c + ro, cy_c + ro], fill=color)
        draw.ellipse([cx_c - ri, cy_c - ri, cx_c + ri, cy_c + ri], fill=bg_color)
        draw.ellipse([cx_c - rc, cy_c - rc, cx_c + rc, cy_c + rc], fill=color)
    elif style == "Diamond":
        cx_c = x + outer // 2
        cy_c = y + outer // 2
        ho = outer // 2
        hi = inner // 2
        hc = core // 2
        draw.polygon(
            [(cx_c, cy_c - ho), (cx_c + ho, cy_c), (cx_c, cy_c + ho), (cx_c - ho, cy_c)],
            fill=color,
        )
        draw.polygon(
            [(cx_c, cy_c - hi), (cx_c + hi, cy_c), (cx_c, cy_c + hi), (cx_c - hi, cy_c)],
            fill=bg_color,
        )
        draw.polygon(
            [(cx_c, cy_c - hc), (cx_c + hc, cy_c), (cx_c, cy_c + hc), (cx_c - hc, cy_c)],
            fill=color,
        )


# ─────────────────────────────────────────────
# QR renderer
# ─────────────────────────────────────────────
def render_qr(
    data,
    module_style="Square",
    eye_style="Square",
    fg_color="#000000",
    bg_color="#FFFFFF",
    color_mode="Solid",
    gradient_dir="Vertical",
    gradient_end="#000000",
    error_level=ERROR_CORRECT_H,
    module_px=EXPORT_MODULE,
    border=4,
    logo_path=None,
    footer_text="",
):
    """Render a fully-custom QR code and return a PIL Image."""

    # 1. Build matrix
    qr = qrcode.QRCode(
        version=None,
        error_correction=error_level,
        box_size=1,
        border=0,
    )
    qr.add_data(data or "https://example.com")
    qr.make(fit=True)
    matrix = qr.get_matrix()
    mod_count = len(matrix)

    total = mod_count + border * 2
    img_size = total * module_px

    # 2. Background
    bg_rgb = _hex_to_rgb(bg_color)
    img = Image.new("RGB", (img_size, img_size), bg_rgb)
    draw = ImageDraw.Draw(img)

    # 3. Prepare foreground color source
    fg_rgb = _hex_to_rgb(fg_color)
    grad_end_rgb = _hex_to_rgb(gradient_end)
    gradient_img = None
    if color_mode == "Linear Gradient":
        gradient_img = _make_gradient(img_size, img_size, fg_rgb, grad_end_rgb, gradient_dir)
    elif color_mode == "Radial Gradient":
        gradient_img = _make_radial_gradient(img_size, img_size, fg_rgb, grad_end_rgb)

    def _color_at(px_x, px_y):
        if gradient_img:
            px_x = max(0, min(px_x, img_size - 1))
            px_y = max(0, min(px_y, img_size - 1))
            return gradient_img.getpixel((px_x, px_y))
        return fg_rgb

    # 4. Identify finder-pattern regions (top-left, top-right, bottom-left)
    finder_positions = [
        (0, 0),
        (mod_count - 7, 0),
        (0, mod_count - 7),
    ]
    finder_set = set()
    for fr, fc in finder_positions:
        for r in range(fr, fr + 7):
            for c in range(fc, fc + 7):
                finder_set.add((r, c))

    # 5. Draw data modules (skip finders)
    for r in range(mod_count):
        for c in range(mod_count):
            if (r, c) in finder_set:
                continue
            if matrix[r][c]:
                px_x = (c + border) * module_px
                px_y = (r + border) * module_px
                color = _color_at(px_x + module_px // 2, px_y + module_px // 2)
                _draw_module(draw, px_x, px_y, module_px, module_style, color)

    # 6. Draw finder patterns
    for fr, fc in finder_positions:
        px_x = (fc + border) * module_px
        px_y = (fr + border) * module_px
        color = _color_at(px_x + module_px * 3, px_y + module_px * 3)
        _draw_eye(draw, px_x, px_y, module_px, eye_style, color, bg_rgb)

    # 7. Logo
    if logo_path and os.path.isfile(logo_path):
        try:
            logo = Image.open(logo_path).convert("RGBA")
            max_logo = int(img_size * 0.22)
            logo.thumbnail((max_logo, max_logo), Image.LANCZOS)
            # white padding
            pad = module_px
            pad_w = logo.width + pad * 2
            pad_h = logo.height + pad * 2
            pad_img = Image.new("RGBA", (pad_w, pad_h), (255, 255, 255, 255))
            pad_img.paste(logo, (pad, pad), logo)
            lx = (img_size - pad_w) // 2
            ly = (img_size - pad_h) // 2
            img.paste(pad_img, (lx, ly), pad_img)
        except Exception as e:
            print(f"Logo error: {e}")

    # 8. Footer text
    if footer_text.strip():
        try:
            font_size = max(14, module_px * 2)
            try:
                font = ImageFont.truetype("arial.ttf", font_size)
            except OSError:
                font = ImageFont.load_default()
            bbox = font.getbbox(footer_text)
            tw = bbox[2] - bbox[0]
            th = bbox[3] - bbox[1]
            footer_h = th + module_px * 2
            new_img = Image.new("RGB", (img_size, img_size + footer_h), bg_rgb)
            new_img.paste(img, (0, 0))
            fdraw = ImageDraw.Draw(new_img)
            tx = (img_size - tw) // 2
            ty = img_size + (footer_h - th) // 2
            fdraw.text((tx, ty), footer_text, fill=fg_rgb, font=font)
            img = new_img
        except Exception as e:
            print(f"Footer error: {e}")

    return img


# ─────────────────────────────────────────────
# Tkinter Application
# ─────────────────────────────────────────────
class QRGeneratorApp:
    # Color scheme
    BG_DARK = "#1e1e2e"
    BG_PANEL = "#282840"
    BG_INPUT = "#363654"
    FG_TEXT = "#cdd6f4"
    ACCENT = "#89b4fa"
    ACCENT_HOVER = "#74c7ec"
    BORDER_COLOR = "#45475a"

    def __init__(self, root):
        self.root = root
        self.root.title("✦ QR Code Generator")
        self.root.configure(bg=self.BG_DARK)
        self.root.minsize(960, 700)

        # State
        self.logo_path = None
        self.generated_image = None
        self.tk_preview = None

        self._setup_styles()
        self._build_ui()

    # ── Styles ──────────────────────────────
    def _setup_styles(self):
        style = ttk.Style()
        style.theme_use("clam")

        style.configure(".", background=self.BG_DARK, foreground=self.FG_TEXT, font=("Segoe UI", 10))
        style.configure("TFrame", background=self.BG_DARK)
        style.configure("Panel.TFrame", background=self.BG_PANEL)
        style.configure(
            "TLabel", background=self.BG_PANEL, foreground=self.FG_TEXT, font=("Segoe UI", 10)
        )
        style.configure(
            "Header.TLabel",
            background=self.BG_DARK,
            foreground=self.ACCENT,
            font=("Segoe UI", 18, "bold"),
        )
        style.configure(
            "Section.TLabel",
            background=self.BG_PANEL,
            foreground=self.ACCENT,
            font=("Segoe UI", 11, "bold"),
        )
        style.configure(
            "TCombobox",
            fieldbackground=self.BG_INPUT,
            background=self.BG_INPUT,
            foreground=self.FG_TEXT,
            selectbackground=self.ACCENT,
            selectforeground="#1e1e2e",
        )
        style.map(
            "TCombobox",
            fieldbackground=[("readonly", self.BG_INPUT)],
            foreground=[("readonly", self.FG_TEXT)],
        )
        style.configure(
            "TEntry",
            fieldbackground=self.BG_INPUT,
            foreground=self.FG_TEXT,
            insertcolor=self.FG_TEXT,
        )
        style.configure(
            "Accent.TButton",
            background=self.ACCENT,
            foreground="#1e1e2e",
            font=("Segoe UI", 11, "bold"),
            padding=(12, 8),
        )
        style.map(
            "Accent.TButton",
            background=[("active", self.ACCENT_HOVER)],
        )
        style.configure(
            "Secondary.TButton",
            background=self.BG_INPUT,
            foreground=self.FG_TEXT,
            font=("Segoe UI", 10),
            padding=(10, 6),
        )
        style.map(
            "Secondary.TButton",
            background=[("active", self.BORDER_COLOR)],
        )
        style.configure(
            "TSpinbox",
            fieldbackground=self.BG_INPUT,
            background=self.BG_INPUT,
            foreground=self.FG_TEXT,
            arrowcolor=self.FG_TEXT,
        )

    # ── UI Construction ─────────────────────
    def _build_ui(self):
        # Header
        header = ttk.Frame(self.root)
        header.pack(fill="x", pady=(12, 4), padx=16)
        ttk.Label(header, text="✦  QR Code Generator", style="Header.TLabel").pack(side="left")

        # Main paned
        main = ttk.Frame(self.root)
        main.pack(fill="both", expand=True, padx=16, pady=8)

        # ── Left: controls ──
        left_outer = ttk.Frame(main, style="Panel.TFrame")
        left_outer.pack(side="left", fill="y", padx=(0, 8))

        # Canvas + scrollbar for controls
        canvas = tk.Canvas(
            left_outer, bg=self.BG_PANEL, highlightthickness=0, width=310, bd=0
        )
        scrollbar = ttk.Scrollbar(left_outer, orient="vertical", command=canvas.yview)
        self.ctrl_frame = ttk.Frame(canvas, style="Panel.TFrame")
        self.ctrl_frame.bind(
            "<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        canvas.create_window((0, 0), window=self.ctrl_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        # Bind mousewheel
        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        pad = {"padx": 12, "pady": 3}
        pad_section = {"padx": 12, "pady": (14, 4)}

        # ── URL ──
        self._section("🔗  URL / Text", **pad_section)
        self.url_var = tk.StringVar(value="https://google.com")
        entry = ttk.Entry(self.ctrl_frame, textvariable=self.url_var, width=36)
        entry.pack(**pad)

        # ── Pattern ──
        self._section("🔲  Pattern", **pad_section)
        self._label("Module Style")
        self.module_var = tk.StringVar(value=MODULE_STYLES[0])
        ttk.Combobox(
            self.ctrl_frame, textvariable=self.module_var, values=MODULE_STYLES,
            state="readonly", width=33
        ).pack(**pad)

        self._label("Eye Style")
        self.eye_var = tk.StringVar(value=EYE_STYLES[0])
        ttk.Combobox(
            self.ctrl_frame, textvariable=self.eye_var, values=EYE_STYLES,
            state="readonly", width=33
        ).pack(**pad)

        # ── Colors ──
        self._section("🎨  Colors", **pad_section)

        # FG color
        fg_frame = ttk.Frame(self.ctrl_frame, style="Panel.TFrame")
        fg_frame.pack(fill="x", **pad)
        ttk.Label(fg_frame, text="Foreground").pack(side="left")
        self.fg_color_var = tk.StringVar(value="#000000")
        self.fg_swatch = tk.Label(
            fg_frame, bg="#000000", width=4, height=1, relief="solid", bd=1, cursor="hand2"
        )
        self.fg_swatch.pack(side="right", padx=4)
        self.fg_swatch.bind("<Button-1>", lambda e: self._pick_color(self.fg_color_var, self.fg_swatch))

        # BG color
        bg_frame = ttk.Frame(self.ctrl_frame, style="Panel.TFrame")
        bg_frame.pack(fill="x", **pad)
        ttk.Label(bg_frame, text="Background").pack(side="left")
        self.bg_color_var = tk.StringVar(value="#FFFFFF")
        self.bg_swatch = tk.Label(
            bg_frame, bg="#FFFFFF", width=4, height=1, relief="solid", bd=1, cursor="hand2"
        )
        self.bg_swatch.pack(side="right", padx=4)
        self.bg_swatch.bind("<Button-1>", lambda e: self._pick_color(self.bg_color_var, self.bg_swatch))

        # Color mode
        self._label("Color Mode")
        self.color_mode_var = tk.StringVar(value=COLOR_MODES[0])
        cm_combo = ttk.Combobox(
            self.ctrl_frame, textvariable=self.color_mode_var, values=COLOR_MODES,
            state="readonly", width=33,
        )
        cm_combo.pack(**pad)
        cm_combo.bind("<<ComboboxSelected>>", self._on_color_mode_change)

        # Gradient direction
        self._label("Gradient Direction")
        self.grad_dir_var = tk.StringVar(value=GRADIENT_DIRS[0])
        self.grad_dir_combo = ttk.Combobox(
            self.ctrl_frame, textvariable=self.grad_dir_var, values=GRADIENT_DIRS,
            state="readonly", width=33
        )
        self.grad_dir_combo.pack(**pad)

        # Gradient end color
        ge_frame = ttk.Frame(self.ctrl_frame, style="Panel.TFrame")
        ge_frame.pack(fill="x", **pad)
        ttk.Label(ge_frame, text="Gradient End Color").pack(side="left")
        self.grad_end_var = tk.StringVar(value="#6c3483")
        self.ge_swatch = tk.Label(
            ge_frame, bg="#6c3483", width=4, height=1, relief="solid", bd=1, cursor="hand2"
        )
        self.ge_swatch.pack(side="right", padx=4)
        self.ge_swatch.bind("<Button-1>", lambda e: self._pick_color(self.grad_end_var, self.ge_swatch))

        # ── Options ──
        self._section("⚙  Options", **pad_section)

        self._label("Error Correction")
        self.ec_var = tk.StringVar(value="H  (~30%)")
        ttk.Combobox(
            self.ctrl_frame, textvariable=self.ec_var, values=list(ERROR_LEVELS.keys()),
            state="readonly", width=33
        ).pack(**pad)

        self._label("Module Size (px)")
        self.modsize_var = tk.IntVar(value=20)
        ttk.Spinbox(
            self.ctrl_frame, from_=8, to=40, textvariable=self.modsize_var, width=10
        ).pack(**pad, anchor="w")

        self._label("Border (modules)")
        self.border_var = tk.IntVar(value=4)
        ttk.Spinbox(
            self.ctrl_frame, from_=0, to=10, textvariable=self.border_var, width=10
        ).pack(**pad, anchor="w")

        # ── Logo ──
        self._section("🖼  Logo", **pad_section)
        btn_frame = ttk.Frame(self.ctrl_frame, style="Panel.TFrame")
        btn_frame.pack(fill="x", **pad)
        ttk.Button(
            btn_frame, text="Browse Logo", style="Secondary.TButton", command=self._browse_logo
        ).pack(side="left", padx=(0, 6))
        ttk.Button(
            btn_frame, text="Remove", style="Secondary.TButton", command=self._remove_logo
        ).pack(side="left")
        self.logo_label = ttk.Label(self.ctrl_frame, text="No logo selected", wraplength=260)
        self.logo_label.pack(**pad, anchor="w")

        # ── Footer ──
        self._section("📝  Footer Text", **pad_section)
        self.footer_var = tk.StringVar()
        ttk.Entry(self.ctrl_frame, textvariable=self.footer_var, width=36).pack(**pad)

        # ── Action buttons ──
        act_frame = ttk.Frame(self.ctrl_frame, style="Panel.TFrame")
        act_frame.pack(fill="x", padx=12, pady=(18, 12))
        ttk.Button(
            act_frame, text="⚡  Generate QR", style="Accent.TButton", command=self._generate
        ).pack(fill="x", pady=(0, 6))
        ttk.Button(
            act_frame, text="💾  Save as PNG", style="Accent.TButton", command=self._save
        ).pack(fill="x")

        # ── Right: preview ──
        right = ttk.Frame(main, style="Panel.TFrame")
        right.pack(side="left", fill="both", expand=True, padx=(8, 0))

        ttk.Label(right, text="Preview", style="Section.TLabel").pack(pady=(10, 4))
        self.preview_canvas = tk.Canvas(
            right,
            bg=self.BG_INPUT,
            width=PREVIEW_SIZE,
            height=PREVIEW_SIZE,
            highlightthickness=1,
            highlightbackground=self.BORDER_COLOR,
        )
        self.preview_canvas.pack(padx=20, pady=10, expand=True)

        # Draw placeholder
        self.preview_canvas.create_text(
            PREVIEW_SIZE // 2, PREVIEW_SIZE // 2,
            text="Your QR code\nwill appear here",
            fill="#585b70",
            font=("Segoe UI", 14),
            justify="center",
        )

    # ── Helpers ──
    def _section(self, text, **kw):
        ttk.Label(self.ctrl_frame, text=text, style="Section.TLabel").pack(anchor="w", **kw)

    def _label(self, text):
        ttk.Label(self.ctrl_frame, text=text).pack(anchor="w", padx=12, pady=(6, 0))

    def _pick_color(self, var, swatch):
        result = colorchooser.askcolor(color=var.get(), title="Pick a color")
        if result and result[1]:
            var.set(result[1])
            swatch.configure(bg=result[1])

    def _on_color_mode_change(self, event=None):
        mode = self.color_mode_var.get()
        state = "readonly" if mode != "Solid" else "disabled"
        self.grad_dir_combo.configure(state=state)

    def _browse_logo(self):
        path = filedialog.askopenfilename(
            filetypes=[("Image files", "*.png *.jpg *.jpeg *.bmp *.gif *.ico")],
            title="Select Logo",
        )
        if path:
            self.logo_path = path
            name = os.path.basename(path)
            self.logo_label.configure(text=f"✓ {name}")
            # Auto-set error correction to H for best logo support
            self.ec_var.set("H  (~30%)")

    def _remove_logo(self):
        self.logo_path = None
        self.logo_label.configure(text="No logo selected")

    # ── Generate ────────────────────────────
    def _generate(self):
        data = self.url_var.get().strip()
        if not data:
            messagebox.showwarning("Input Required", "Please enter a URL or text.")
            return

        try:
            self.generated_image = render_qr(
                data=data,
                module_style=self.module_var.get(),
                eye_style=self.eye_var.get(),
                fg_color=self.fg_color_var.get(),
                bg_color=self.bg_color_var.get(),
                color_mode=self.color_mode_var.get(),
                gradient_dir=self.grad_dir_var.get(),
                gradient_end=self.grad_end_var.get(),
                error_level=ERROR_LEVELS.get(self.ec_var.get(), ERROR_CORRECT_H),
                module_px=self.modsize_var.get(),
                border=self.border_var.get(),
                logo_path=self.logo_path,
                footer_text=self.footer_var.get(),
            )
            self._update_preview()
        except Exception as e:
            messagebox.showerror("Error", f"Failed to generate QR code:\n{e}")

    def _update_preview(self):
        if not self.generated_image:
            return
        img = self.generated_image.copy()
        img.thumbnail((PREVIEW_SIZE, PREVIEW_SIZE), Image.LANCZOS)
        self.tk_preview = ImageTk.PhotoImage(img)
        self.preview_canvas.delete("all")
        self.preview_canvas.create_image(
            PREVIEW_SIZE // 2, PREVIEW_SIZE // 2, image=self.tk_preview, anchor="center"
        )

    # ── Save ────────────────────────────────
    def _save(self):
        if not self.generated_image:
            messagebox.showinfo("Nothing to save", "Generate a QR code first.")
            return
        path = filedialog.asksaveasfilename(
            defaultextension=".png",
            filetypes=[("PNG Image", "*.png"), ("JPEG Image", "*.jpg")],
            title="Save QR Code",
        )
        if path:
            self.generated_image.save(path)
            messagebox.showinfo("Saved", f"QR code saved to:\n{path}")


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────
if __name__ == "__main__":
    root = tk.Tk()
    app = QRGeneratorApp(root)
    root.mainloop()
