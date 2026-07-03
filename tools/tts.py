# PM Bridge TTS - Edge neural voice with corporate-proxy support.
# usage: python tts.py <voice> <rate> <out.mp3>   (text via stdin, UTF-8)
import sys, asyncio, io

try:
    import truststore
    truststore.inject_into_ssl()          # use Windows cert store (corp proxies)
except Exception:
    pass

import edge_tts

async def main():
    voice, rate, out = sys.argv[1], sys.argv[2], sys.argv[3]
    text = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8").read().strip()
    if not text:
        sys.exit(2)
    await edge_tts.Communicate(text, voice, rate=rate).save(out)

asyncio.run(main())
