# Cheat sheet: ffmpeg for the Composer

> Verify flags against ffmpeg.org documentation for the installed version.
> The `subtitles` filter requires ffmpeg built with libass (standard in Debian/Ubuntu packages).

## Duration

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 audio/S01.wav
```

## Silence gap (same format as Kokoro output: 24 kHz mono)

```bash
ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t 0.4 -c:a pcm_s16le audio/gap.wav
```

## Concatenate clips (concat demuxer)

```text
# audio/list.txt
file 'S00.wav'
file 'gap.wav'
file 'S01.wav'
file 'gap.wav'
file 'S02.wav'
```

```bash
ffmpeg -y -f concat -safe 0 -i audio/list.txt -c copy audio/full.wav
```

All inputs must share codec, sample rate and channel layout for `-c copy`.
Match the gap's `pcm_*` codec to what Kokoro returns (check with ffprobe).

## Trim, merge, encode

```bash
ffmpeg -y -ss 0.85 -i video.webm -i audio/full.wav \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 128k \
  -shortest -movflags +faststart final.mp4
```

`-ss` before `-i` trims the Recorder's t0 (here 0.85 s).

## Burn in subtitles

```bash
ffmpeg -y -ss 0.85 -i video.webm -i audio/full.wav -map 0:v:0 -map 1:a:0 \
  -vf "subtitles=subtitles.srt:force_style='FontSize=20,MarginV=30'" \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k \
  -shortest -movflags +faststart final.mp4
```

Paths with `:` or `'` need escaping inside the filter; use a relative path and set `cwd`.

## SRT format

```text
1
00:00:00,000 --> 00:00:04,200
Hi. This is a review of the change that adds
the place order handler to the order service.

2
00:00:04,200 --> 00:00:07,900
I found three things worth your attention.
```

Split long steps into cues of at most 2 lines and ~42 characters per line, distributing
time proportionally to character count.

## Optional loudness normalization

```bash
ffmpeg -y -i audio/full.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 audio/full.norm.wav
```

## Final check

```bash
ffprobe -v error -show_entries stream=codec_type,duration -of compact final.mp4
```

Fail the stage if video and audio durations differ by more than 250 ms.
