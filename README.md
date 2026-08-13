# AWA Toolkit

![AWA Toolkit Icon](awa-toolkit.png)

![Preview of the AWA Toolkit](preview.png)

* **Artifact Optimizer** — ARP-maximizing loadouts from your owned artifacts, a Control Center ARP task list, and one-click equip/upgrade
* **filters** giveaways and Game Vault items (higher tier, claimed, out of stock)
* Adds **Reading mode** and restores **Classic tables** on UCF threads.

## Install

[Install](https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/dist/awa-toolkit.user.js)

_No userscript manager yet? Install [Violentmonkey](https://violentmonkey.github.io/get-it/) first, then use the link above._

_Recommended browser: [Zen](https://zen-browser.app/) or [Firefox](https://www.firefox.com)_

Open the user menu gear and choose **Artifact Optimizer** or **Filter Settings**. On **Control Center**, an injected panel shows a prioritized **What to do** list plus Equip / Open Full Panel buttons.

## Artifact Optimizer

* Scrapes your Artifact Showroom (`/user-artifacts-room` → `/member/<you>/artifacts`) for owned artifacts, tiers, equipped slots, fragment balance, and **24h slot locks** (`fa-lock` / disabled modal slots). The Control Center / Showroom panels inject as soon as the page shell exists (does not wait for AWA to finish hydrating), paint from cached data (skeleton while that loads), then refresh Showroom / Battle Pass / Game Vault / Steam in the background when stale (~6h). Manual overrides stay under Advanced.
* Detects a LIVE Steam Community Event from the Control Center banner, then autofetches that event page (~6h while live) and scores **unawarded milestone ARP** the 24h lock will still be wearing: personal hours not met yet, or community unlock with an ASCE ETA inside that lock (unknown ETA is not guessed). Rewards auto-grant when **both** gates are true. Community-hour rate / unlock ETA uses [ASCE](https://github.com/MarvashMagalli/ASCE)'s hourly `stored_hours.json` (matched to the live event slug) instead of sampling the event page on each visit. ASCE timestamps are fetch times, not AWA update times. Cross-checks [ARP Log](https://na.alienwarearena.com/account/arp-log) `Steam Community Event Reward` lines so already-received lumps are not treated as pending. Only **All ARP %** (HPC / Zorathian) boosts those lumps — Steam / Twitch artifacts do not.
* Pulls [ARP Log](https://na.alienwarearena.com/account/arp-log) at least once per **24h** (also when you visit the page) for recent earn lines and balance.
* Scores every 3-artifact combo for the **next 24h swap window** (remaining today, plus the next 00:00 UTC dailies when today is already capped, plus Monday Steam Quests when that reset falls inside the lock): category flat bonuses first, then blanket **All ARP %** multiplier (H\`erkow Plasma Chamber / Zorathian Renaissance). Market-discount loadouts are suggested before Game Vault opens only if a 24h lock would still be running at open (so discount gear would not be equippable in time) **and** current redeemable ARP plus remaining 24h activity earnings can cover at least one posted eligible game (in-stock, your tier, with discount if needed). If nothing is in that ARP range, ARP recs continue (same as skipping vault discount). After open, recs follow live stock/tier the same way — so an ARP swap is not recommended when it would 24h-lock discount gear before a same-window purchase. Blind auctions are ignored (Discord: discount does not apply). Vault discount recs can be **dismissed** for that rotation if you are not buying.
* Shows a **long-term META upgrade path** (HPC → Pn295 Twitch → Chai → …). That list is a plan only — fragments are never spent unless you confirm **Upgrade**. Leftover shards are not suggested on cheaper sidegrades. Equip recommendations use the tiers you actually own.
* Reads Control Center activity caps, Game Vault prices, and Battle Pass claim status from those pages (live when you are on them; otherwise via background fetch).
* One-click equip / upgrade via the site's real APIs, with confirmation and best-effort local 24h slot-cooldown tracking (seeded from Showroom lock icons when Unequip is hidden). On the Artifact Showroom, **Equip Monthly META** puts on Megumin's standing 3-set (HPC + Chai + Pn295, or Pn295 + Chai + Ba'li, or Zorathian) for people who want the all-month loadout instead of today's 24h recommendation. If slots are stuck on a 24h lock, the Showroom task list mentions Megumin's workaround: click Upgrade on a maxed artifact (0 fragments) to clear it.
* Optional **desktop notifications** (userscript manager → OS notification center) when a pending artifact swap's 24h slot cooldown ends, community hours unlock, Game Vault opens or adds games, or a new official key giveaway is posted on [`/ucf/Giveaway`](https://na.alienwarearena.com/ucf/Giveaway). Enable the master toggle in the full panel, then use the smaller per-type switches. An Alienware Arena tab must stay open for the timer to fire; once shown, the notification can persist after that tab closes. The first giveaway / vault-catalog check only seeds what is already posted so you are not flooded.

## UCF Posts

On UCF posts (`/ucf/show/...`), a sticky bar has:

* **Reading mode** — hides the board-list sidebar and compact author columns so threads use the full width (also in the Reply button row).
* **Classic tables** — restores the old bordered table layout (the published forum view strips table borders, which is why guides fall back to dash-line "tables"). On by default.
* **Top / Bottom** — jump to the start or end of the original post (stays on the right of the sticky bar).

Layout choices are remembered for all UCF posts.

## Limitations

* Server-side slot cooldowns are not exposed in the DOM; cooldown warnings use a local action log.
* Desktop notifications can only be *scheduled* while an Alienware Arena tab is open. Once fired they persist in the OS notification center (Tampermonkey `tag`/`url`, Violentmonkey `zombieTimeout`).
* Some activity signals are best-effort and default to "still available" when markup differs.
* Steam Quests and Steam Community Events require **owning the game** on the linked Steam account (family sharing doesn't count). Upcoming titles aren't known until AWA posts them. **Check Game** / **Visit Steam** / **Sync Games** means the game isn't showing as owned yet (play ~10 min after adding it). Paid games are skipped; Steam `is_free` (or currently $0 / 100% off) titles stay on the list. Choose Your Own Game stays eligible.
* Battle Pass milestone thresholds are not hardcoded (season-dependent); ready-to-claim counts are informational.

## Credits

Artifact ARP math, activity baselines, and META build guidance are based on [Megumin's Tools](https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?usp=sharing) ([Artifact Upgrade C/P](https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?gid=1046753957#gid=1046753957), [ARP Calculator](https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?gid=1289162159#gid=1289162159)), the [【Artifacts】Info](https://www.alienwarearena.com/ucf/show/2167784) UCF thread, and Megumin's Discord meta guides found in the AWA Discord server.
Community-event hour history is from [ASCE](https://github.com/MarvashMagalli/ASCE).
