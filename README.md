# SafeNest: family safety addon for Nuvio (Cloudflare Workers, free)

Primary source: Common Sense Media (age + Violence / Sex / Language). Fallbacks: isitsafe.tv, Kids-In-Mind, IMDb.
Label = the worse of the Common Sense age band (<=9 safe, 10-14 slightly, 15+ unsafe) and the worst category.
Categories are capped by the age, so a kids' title can never come out unsafe from one badly read line.

## Files for GitHub (upload, do not paste)
src/index.js, src/parse.js, src/kim.js, src/extra.js, tests/golden.test.mjs, package.json, wrangler.toml

## Safety net (do once)
Cloudflare > Worker > Settings > Builds > Build command: npm test
Every build now runs tests/golden.test.mjs; if a known title gets a wrong label the build fails and is not deployed.

## Pages (replace <worker> with your address)
- /card/movie/tt123        graphic card with badge (the stream card links here)
- /badge/movie/tt123.svg   badge image;  /badge/UNSAFE.svg?age=12 for a plain label badge
- /api/movie/tt123.json    the same data as JSON
- /regex                   shows the hidden label regex and tests it on a real title
- /debug/movie/tt123       what every source returned
