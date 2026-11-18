"""Builds media/bountylens-demo.mp4 (< 3 min): title slides + real app screenshots + Windows TTS narration.

Usage: python media/make_video.py <folder with s1-start.jpg, s2-flags.jpg, s3-device.jpg, s4-cloud.jpg, s5-pipeline.jpg>
"""
import subprocess
import sys
import wave
from pathlib import Path

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).parent
SHOTS = Path(sys.argv[1])
WORK = HERE / "video-work"
WORK.mkdir(exist_ok=True)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
BG, INK, MUTED, BRAND = (14, 16, 32), (232, 234, 245), (154, 160, 187), (129, 140, 248)


def font(size, bold=False):
    for name in (["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def slide(n, title, lines, kicker="BOUNTY LENS"):
    im = Image.new("RGB", (1920, 1080), BG)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([140, 120, 200, 180], radius=14, fill=BRAND)
    d.text((230, 128), kicker, font=font(34, True), fill=BRAND)
    d.text((140, 230), title, font=font(74, True), fill=INK)
    y = 400
    for line in lines:
        d.ellipse([150, y + 22, 166, y + 38], fill=BRAND)
        d.text((190, y), line, font=font(44), fill=INK)
        y += 80
    p = WORK / f"slide-{n:02d}.png"
    im.save(p)
    return p


S1 = slide(1, "Is this bounty worth your weekend?", [
    "Private triage for hackathons, bounties and grants",
    "Gemini Nano on your device first",
    "Gemini in the cloud only when needed",
    "Built on Firebase AI Logic hybrid inference",
], kicker="BOUNTY LENS  ·  #BuildHybridAI 2026")
S2 = slide(2, "How it works", [
    "Local red-flag scan (rules from Remote Config)",
    "PREFER_ON_DEVICE: Gemini Nano via Chrome Prompt API",
    "Same JSON schema on device and in the cloud",
    "Local rules can only make a verdict stricter",
    "App Check · anonymous Auth · Firestore pipeline",
])
S3 = slide(3, "Try it", [
    "emilpz320-a11y.github.io/bounty-lens",
    "github.com/emilpz320-a11y/bounty-lens (Apache-2.0)",
    "Thank you!",
])

D = lambda name: SHOTS / name
ON_DEVICE = (SHOTS / "s3-device.jpg").exists()
if ON_DEVICE:
    S1_SHOT = (D("s1-start.jpg"), "Paste a page. The status bar shows that Gemini Nano is available on this machine, and that Firebase AI Logic is ready as a cloud fallback.")
    S3_SHOT = (D("s3-device.jpg"), "With prefer on device, Firebase AI Logic runs Gemini Nano through Chrome's built in Prompt A P I, constrained to a J S O N schema. The page never leaves the computer. The result shows the deadline, the prize per winner, the deliverables, the blockers, a verdict, and expected dollars per hour.")
    S4_SHOT = (D("s4-cloud.jpg"), "If the device can't run the model, the same request goes to Gemini in the cloud with the same schema, so the interface does not change. Every result says where it ran and how long it took.")
else:  # cloud-only recording: the recording machine cannot run Gemini Nano
    S1_SHOT = (D("s1-start.jpg"), "Paste a page. The status bar shows whether Gemini Nano can run on this machine. On the computer used for this recording it is unavailable, so Firebase AI Logic is ready to use the cloud instead.")
    S3_SHOT = None
    S4_SHOT = (D("s4-cloud.jpg"), "When Gemini Nano is available, prefer on device mode runs it through Chrome's built in Prompt A P I, and the page never leaves the computer. Here the device can't run it, so the same request, with the same J S O N schema, goes to Gemini in the cloud. The result shows the deadline, the prize per winner, the deliverables, the blockers, a verdict and expected dollars per hour, and says where it ran and how long it took.")
SEGMENTS = [
    (S1, "Solo builders read dozens of hackathon and bounty pages a week. The expensive part is the fine print. Bounty Lens reads it for you, privately, on your own device."),
    S1_SHOT,
    (D("s2-flags.jpg"), "Before any model runs, a local scan flags anything that needs your money, a student I D, K Y C or attendance in person. The rules come from Remote Config, and negations like no entry fee are ignored."),
    S3_SHOT,
    S4_SHOT,
    (D("s5-pipeline.jpg"), "Saved briefs sync to Firestore under an anonymous Firebase user, and the pipeline ranks them: go first, then the best dollars per hour, then the nearest deadline."),
    (S2, "Under the hood: a deterministic scan from Remote Config, hybrid inference with one schema for both paths, local rules that can only make a verdict stricter, and App Check, Auth and Firestore with field level security rules."),
    (S3, "Try Bounty Lens on the web, and read the code on GitHub. Thank you."),
]
SEGMENTS = [seg for seg in SEGMENTS if seg is not None]


def tts(text: str, out: Path) -> float:
    out.with_suffix(".txt").write_text(text, encoding="utf-8")
    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "try { $s.SelectVoice('Microsoft Zira Desktop') } catch {}; $s.Rate = 1; "
        f"$s.SetOutputToWaveFile('{out}'); "
        f"$s.Speak([IO.File]::ReadAllText('{out.with_suffix('.txt')}')); $s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True)
    with wave.open(str(out)) as w:
        return w.getnframes() / w.getframerate()


parts = []
for i, (img, text) in enumerate(SEGMENTS):
    wav = WORK / f"seg{i:02d}.wav"
    dur = tts(text, wav) + 0.7
    mp4 = WORK / f"seg{i:02d}.mp4"
    vf = "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0e1020,format=yuv420p"
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", str(img), "-i", str(wav),
                    "-af", "apad", "-t", f"{dur:.2f}", "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "23",
                    "-c:a", "aac", "-b:a", "128k", "-ar", "44100", str(mp4)], check=True)
    parts.append(mp4)
    print(f"segment {i}: {dur:.1f}s")

listing = WORK / "list.txt"
listing.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
out = HERE / "bountylens-demo.mp4"
subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(out)], check=True)
print("wrote", out)
