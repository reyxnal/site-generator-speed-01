# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/reyxnal/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/reyxnal/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in for makefun-site 1.0.0: `run(input)` returns exactly the output
tree makefun-site 1.0.0's `build(input)` returns for one site, byte for byte —
but faster (about 3.5x the house baseline on the practice set, measured beside
it on the same machine).

How it gets there, without changing any answer:

- Inline Markdown is scanned in whole runs instead of one character at a time
  (the reference calls its HTML escaper once per character).
- The block lexer dispatches on each line's first character instead of testing
  eight regexes per line, renders each block as it lexes it, and shares one line
  split between the front matter and the body.
- Slugs are cached per build (tag names repeat heavily) and ASCII strings skip
  the Unicode normalisation, which is the identity on ASCII.
- Word counting is done by hand instead of `/\S+/g`.
- Template rendering pushes into one output array per render instead of
  concatenating a string per node, and reuses one scope object per loop.

Verified byte-identical to the reference on the practice set and on 120
generator-drawn cases plus 64 hand-built edge cases (front matter, Markdown,
templates, slugs, tags, links, CRLF).

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=50sebr5q&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
