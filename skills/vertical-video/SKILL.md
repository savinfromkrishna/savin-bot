---
name: vertical-video
description: ffmpeg recipes for 9:16 exports, burned-in captions, trims and thumbnails.
---

# Check the tools first

`ffmpeg -version` and `ffprobe -version`. If missing, report it instead of guessing.

# Recipes

- Inspect: `ffprobe -v error -show_entries stream=width,height,duration -of compact input.mp4`
- 9:16 crop from 16:9 (centre): `ffmpeg -i in.mp4 -vf "crop=ih*9/16:ih,scale=1080:1920" -c:a copy out.mp4`
- 9:16 with blurred background (keeps the whole frame):
  `ffmpeg -i in.mp4 -filter_complex "[0]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg];[0]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2" -c:a copy out.mp4`
- Trim: `ffmpeg -ss 00:00:05 -to 00:00:50 -i in.mp4 -c copy clip.mp4`
- Burn captions from SRT: `ffmpeg -i in.mp4 -vf "subtitles=captions.srt:force_style='Fontsize=18,Alignment=2,MarginV=120'" out.mp4`
- Thumbnail at 3 s: `ffmpeg -ss 3 -i in.mp4 -frames:v 1 -q:v 2 thumb.jpg`
- Loudness to -14 LUFS: `ffmpeg -i in.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:v copy out.mp4`

Keep every output next to its post's script and list the paths in your report.
