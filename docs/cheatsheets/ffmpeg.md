# Cheat sheet: ffmpeg for the Composer

> Verify flags against ffmpeg.org documentation for the installed version.
> **Read the next two warnings before writing any ffmpeg call in this project.** Both were
> learned the hard way at Milestone 2 step 5 (ADR-033).
>
> **1. Every command below is written for a shell. This project does not use one.**
> `src/lib/exec.ts` runs with `shell: false`, so quotes that a shell would strip arrive at
> ffmpeg literally and its filter parser refuses them. `force_style='FontSize=20'` works when
> you paste it into a terminal and fails from `execa`.
>
> **2. The `subtitles` filter requires ffmpeg built with libass.** Debian and Ubuntu packages
> have it; **Homebrew's regular `ffmpeg` formula does not** - only `ffmpeg-full`. Check with
> `ffmpeg -filters | grep subtitles` before relying on burn-in, because a build without it fails
> with a confusing complaint about option names rather than "no such filter".

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

## Deliberately not done yet: loudness normalization

```bash
ffmpeg -y -i audio/full.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 audio/full.norm.wav
```

Left out of the Composer on purpose (ADR-033): it is a second encode pass committing to a
target loudness nobody has measured against, and Kokoro's clips sounded fine when they were
listened to. Revisit if a real video sounds wrong.

## Final check

```bash
ffprobe -v error -show_entries stream=codec_type,duration -of compact final.mp4
```

Fail the stage if video and audio durations differ by more than 250 ms.
