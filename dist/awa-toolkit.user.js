// ==UserScript==
// @name         AWA Toolkit
// @namespace    https://github.com/UpDownLeftDie/AWA-Toolkit
// @version      2.2.0
// @author       jaredcat
// @description  Artifact Optimizer, Control Center tasks, giveaway/vault filters, and UCF reading mode
// @license      AGPL-3.0-or-later
// @icon         https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon.png
// @icon64       https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon64.png
// @homepageURL  https://github.com/UpDownLeftDie/AWA-Toolkit
// @supportURL   https://github.com/UpDownLeftDie/AWA-Toolkit/issues
// @downloadURL  https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/dist/awa-toolkit.user.js
// @updateURL    https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/dist/awa-toolkit.user.js
// @match        *://*.alienwarearena.com/*
// @connect      store.steampowered.com
// @connect      raw.githubusercontent.com
// @grant        GM.getValue
// @grant        GM.notification
// @grant        GM.openInTab
// @grant        GM.setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        window.focus
// @run-at       document-start
// ==/UserScript==

(async function() {
	"use strict";
	var _GM = (() => typeof GM != "undefined" ? GM : void 0)();
	var _GM_xmlhttpRequest = (() => typeof GM_xmlhttpRequest != "undefined" ? GM_xmlhttpRequest : void 0)();
	var _unsafeWindow = (() => typeof unsafeWindow != "undefined" ? unsafeWindow : void 0)();
	var STEAM_FREE_CACHE_KEY = "steamAppFreeCache";
	var STEAM_FREE_TTL_PERMANENT_MS = 6048e5;
	var STEAM_FREE_TTL_PRICE_MS = 864e5;
	var STEAM_FREE_TTL_ERROR_MS = 36e5;
	var STEAM_LIBRARY_PENDING_HINT = `Free on Steam — add it and play ~${String(10)} min so it shows as owned`;
	function parseSteamAppId(value) {
		if (!value) return;
		const id = Number(value);
		if (!Number.isSafeInteger(id) || id <= 0) return;
		return id;
	}
	function scrapeSteamAppIdFromDocument(document_) {
		for (const image of document_.querySelectorAll("img")) {
			const id = parseSteamAppId(/\/steam\/apps\/(\d{2,10})\//.exec(image.src)?.[1]);
			if (id !== void 0) return id;
		}
		for (const link of document_.querySelectorAll("a[href]")) {
			const href = link.getAttribute("href") ?? "";
			const fromRun = /^steam:\/\/run\/(\d{2,10})/i.exec(href);
			const fromStore = /store\.steampowered\.com\/app\/(\d{2,10})/i.exec(href);
			const id = parseSteamAppId(fromRun?.[1] ?? fromStore?.[1]);
			if (id !== void 0) return id;
		}
	}
	function steamFreeFromDetails(data) {
		if (data.is_free === true) return {
			isFree: true,
			permanent: true
		};
		const price = data.price_overview;
		return {
			isFree: price?.final === 0 || (price?.discount_percent ?? 0) >= 100,
			permanent: false
		};
	}
	function cacheTtlMs(entry) {
		if (entry.error) return STEAM_FREE_TTL_ERROR_MS;
		if (entry.permanent) return STEAM_FREE_TTL_PERMANENT_MS;
		return STEAM_FREE_TTL_PRICE_MS;
	}
	function isCacheFresh$1(entry) {
		if (!entry) return false;
		const cachedAt = Date.parse(entry.at);
		if (!Number.isFinite(cachedAt)) return false;
		return Date.now() - cachedAt < cacheTtlMs(entry);
	}
	async function loadSteamFreeCache() {
		const raw = await _GM.getValue(STEAM_FREE_CACHE_KEY);
		if (!raw) return {};
		if (typeof raw !== "string") return raw;
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null) return parsed;
		} catch {
			return {};
		}
		return {};
	}
	async function saveSteamFreeCache(cache) {
		await _GM.setValue(STEAM_FREE_CACHE_KEY, JSON.stringify(cache));
	}
	var inflightLookup$1 = {};
	function fetchSteamAppDetailsBatch(appIds) {
		const ids = [...new Set(appIds)].toSorted((left, right) => left - right);
		if (ids.length === 0) return Promise.resolve({});
		return new Promise((resolve) => {
			_GM_xmlhttpRequest({
				method: "GET",
				url: `https://store.steampowered.com/api/appdetails?appids=${ids.join(",")}&cc=us`,
				anonymous: true,
				timeout: 8e3,
				onload: (response) => {
					if (response.status < 200 || response.status >= 300) {
						resolve(void 0);
						return;
					}
					try {
						const parsed = JSON.parse(response.responseText);
						if (typeof parsed !== "object" || parsed === null) {
							resolve(void 0);
							return;
						}
						resolve(parsed);
					} catch {
						resolve(void 0);
					}
				},
				onerror: () => {
					resolve(void 0);
				},
				ontimeout: () => {
					resolve(void 0);
				}
			});
		});
	}
	async function lookupSteamIsCurrentlyFreeMany(appIds) {
		const unique = [...new Set(appIds)].toSorted((left, right) => left - right);
		const result = new Map();
		if (unique.length === 0) return result;
		const inflightKey = unique.join(",");
		if (inflightLookup$1.key === inflightKey && inflightLookup$1.promise !== void 0) return inflightLookup$1.promise;
		const promise = lookupSteamIsCurrentlyFreeManyUncached(unique, result);
		inflightLookup$1.key = inflightKey;
		inflightLookup$1.promise = promise;
		try {
			return await promise;
		} finally {
			if (inflightLookup$1.key === inflightKey) {
				delete inflightLookup$1.key;
				delete inflightLookup$1.promise;
			}
		}
	}
	async function lookupSteamIsCurrentlyFreeManyUncached(unique, result) {
		const cache = await loadSteamFreeCache();
		const missing = [];
		const nowIso = new Date().toISOString();
		for (const appId of unique) {
			const cached = cache[String(appId)];
			if (isCacheFresh$1(cached)) {
				result.set(appId, cached?.error ? void 0 : cached?.isFree);
				continue;
			}
			missing.push(appId);
		}
		if (missing.length === 0) return result;
		const payload = await fetchSteamAppDetailsBatch(missing);
		for (const appId of missing) {
			const key = String(appId);
			const entry = payload?.[key];
			if (!entry?.success || !entry.data) {
				cache[key] = {
					error: true,
					at: nowIso
				};
				result.set(appId, void 0);
				continue;
			}
			const parsed = steamFreeFromDetails(entry.data);
			const stored = {
				isFree: parsed.isFree,
				at: nowIso
			};
			if (parsed.permanent) stored.permanent = true;
			cache[key] = stored;
			result.set(appId, parsed.isFree);
		}
		await saveSteamFreeCache(cache);
		return result;
	}
	function requiresSteamFreeLookup(item) {
		return item.eligibility === "ineligible" && item.steamAppId !== void 0 && item.isFree === void 0;
	}
	function requiresSteamFreeHydrate(state) {
		if ((state.steamQuests?.quests ?? []).some((quest) => requiresSteamFreeLookup(quest))) return true;
		if (!state.communityEvent) return false;
		return requiresSteamFreeLookup(communityEventFreeGate(state.communityEvent));
	}
	function communityEventFreeGate(event) {
		return {
			eligibility: event.playEligibility ?? "unknown",
			...event.steamAppId !== void 0 && { steamAppId: event.steamAppId },
			...event.isFree !== void 0 && { isFree: event.isFree },
			...event.libraryPending === true && { libraryPending: true }
		};
	}
	function applySteamFreeLookup(item, isFree) {
		if (isFree === true) return {
			...item,
			eligibility: "eligible",
			isFree: true,
			libraryPending: true
		};
		if (isFree === false) return {
			...item,
			isFree: false
		};
		return item;
	}
	async function resolveSiteStateSteamFreeToPlay(next) {
		const quests = next.steamQuests?.quests ?? [];
		const event = next.communityEvent;
		const eventGate = event ? communityEventFreeGate(event) : void 0;
		const appIds = [];
		for (const quest of quests) if (requiresSteamFreeLookup(quest) && quest.steamAppId !== void 0) appIds.push(quest.steamAppId);
		if (eventGate && requiresSteamFreeLookup(eventGate) && eventGate.steamAppId !== void 0) appIds.push(eventGate.steamAppId);
		if (appIds.length === 0) return;
		const freeByAppId = await lookupSteamIsCurrentlyFreeMany(appIds);
		if (quests.length > 0) next.steamQuests = {
			scrapedAt: next.steamQuests?.scrapedAt ?? new Date().toISOString(),
			quests: quests.map((quest) => {
				if (!requiresSteamFreeLookup(quest) || quest.steamAppId === void 0) return quest;
				return applySteamFreeLookup(quest, freeByAppId.get(quest.steamAppId));
			})
		};
		if (!event || !eventGate || !requiresSteamFreeLookup(eventGate) || eventGate.steamAppId === void 0) return;
		const upgraded = applySteamFreeLookup(eventGate, freeByAppId.get(eventGate.steamAppId));
		next.communityEvent = {
			...event,
			playEligibility: upgraded.eligibility,
			...upgraded.steamAppId !== void 0 && { steamAppId: upgraded.steamAppId },
			...upgraded.isFree !== void 0 && { isFree: upgraded.isFree },
			...upgraded.libraryPending === true && { libraryPending: true }
		};
	}
	function pageText(document_ = document) {
		return document_.body?.textContent ?? "";
	}
	function isElementDisplayNone(element) {
		const styleAttribute = element.getAttribute("style") ?? "";
		if (/display:\s*none/i.test(styleAttribute)) return true;
		if (element instanceof HTMLElement && element.style.display === "none") return true;
		return false;
	}
	function isElementVisiblyHidden(element) {
		if (isElementDisplayNone(element) || element.hasAttribute("hidden")) return true;
		if (element.getAttribute("aria-hidden") === "true") return true;
		const className = element.getAttribute("class") ?? "";
		if (/\b(d-none|hidden|hide|invisible)\b/i.test(className)) return true;
		const view = element.ownerDocument.defaultView;
		if (view && element instanceof view.HTMLElement) {
			const style = view.getComputedStyle(element);
			if (style.display === "none" || style.visibility === "hidden") return true;
		}
		return false;
	}
	function controlLabel(element) {
		return (element.textContent ?? "").replaceAll(/\s+/g, " ").trim();
	}
	function findActivityCard(document_, title) {
		const header = [...document_.querySelectorAll("h2, h3, h4")].find((element) => title.test(element.textContent?.trim() ?? ""));
		if (!header) return;
		return header.closest(".user-profile__profile-card, .aa-card, [class*=\"profile-card\"]") ?? header.parentElement?.parentElement ?? void 0;
	}
	function utcDateString(date = new Date()) {
		return date.toISOString().slice(0, 10);
	}
	function parseTimestamp$1(value) {
		if (!value) return NaN;
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : NaN;
	}
	var CREDIT_SOURCES = [
		{
			id: "megumin-tools",
			label: "Megumin's Tools",
			dateAccessed: "2026-08-10",
			url: "https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?usp=sharing",
			links: [{
				label: "Artifact Upgrade C/P",
				url: "https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?gid=1046753957#gid=1046753957"
			}, {
				label: "ARP Calculator",
				url: "https://docs.google.com/spreadsheets/d/1VCzq6Trwc9T_wEsvTANpL7yy8FaJ6psSsKYn4O4riw8/edit?gid=1289162159#gid=1289162159"
			}]
		},
		{
			id: "megumin-ucf-artifacts-info",
			label: "【Artifacts】Info",
			dateAccessed: "2026-08-06",
			url: "https://www.alienwarearena.com/ucf/show/2167784"
		},
		{
			id: "asce",
			label: "ASCE",
			url: "https://github.com/MarvashMagalli/ASCE"
		}
	];
	var ArtifactTier = function(ArtifactTier) {
		ArtifactTier[ArtifactTier["Rust"] = 0] = "Rust";
		ArtifactTier[ArtifactTier["Bronze"] = 1] = "Bronze";
		ArtifactTier[ArtifactTier["Silver"] = 2] = "Silver";
		ArtifactTier[ArtifactTier["Gold"] = 3] = "Gold";
		ArtifactTier[ArtifactTier["Platinum"] = 4] = "Platinum";
		ArtifactTier[ArtifactTier["Interstellar"] = 5] = "Interstellar";
		return ArtifactTier;
	}({});
	var TIER_LABELS = {
		[0]: "Rust",
		[1]: "Bronze",
		[2]: "Silver",
		[3]: "Gold",
		[4]: "Platinum",
		[5]: "Interstellar"
	};
	var FRAGMENT_COST_TO_TIER = {
		[0]: 0,
		[1]: 2,
		[2]: 5,
		[3]: 10,
		[4]: 16,
		[5]: 25
	};
	var ArtifactEffectType = function(ArtifactEffectType) {
		ArtifactEffectType["SteamQuests"] = "SteamQuests";
		ArtifactEffectType["WatchTwitch"] = "WatchTwitch";
		ArtifactEffectType["DailyCalendar"] = "DailyCalendar";
		ArtifactEffectType["TimeOnSite"] = "TimeOnSite";
		ArtifactEffectType["DiscordPoll"] = "DiscordPoll";
		ArtifactEffectType["MarketDiscountPct"] = "MarketDiscountPct";
		ArtifactEffectType["AllArpPct"] = "AllArpPct";
		ArtifactEffectType["CommunityPlaytimePct"] = "CommunityPlaytimePct";
		ArtifactEffectType["UsernameColor"] = "UsernameColor";
		ArtifactEffectType["None"] = "None";
		return ArtifactEffectType;
	}({});
	var ARTIFACTS = [
		{
			id: "sylphin-fission-blade",
			category: "Weapon",
			tierNames: [
				"Broken Sylphin Fission Blade",
				"Basic Sylphin Fission Blade",
				"Extended Sylphin Fission Blade",
				"Sylphin Fission Blade Mk1",
				"Sylphin Fission Blade Mk3",
				"Kylorf's Sylphin Fission Blade"
			],
			effects: [
				1,
				2,
				4,
				6,
				8,
				12
			],
			effectType: "SteamQuests",
			effectUnit: "flat"
		},
		{
			id: "pn295",
			category: "Tech",
			tierNames: [
				"Pn295 Unstable",
				"Pn295 Controlled",
				"Pn295 Fusion",
				"Pn295 Alloy",
				"Slyphin Battle Armor",
				"Pn295 Collapsed Star"
			],
			effects: [
				1,
				2,
				4,
				7,
				10,
				15
			],
			effectType: "WatchTwitch",
			effectUnit: "flat"
		},
		{
			id: "light-warping",
			category: "Language",
			tierNames: [
				"Rudimentary Light Warping",
				"Simplistic Light Warping",
				"Phase Light Warping",
				"Bonded Phase Light Warping",
				"PLW Conduit RX13",
				"Light Warp Forerunners"
			],
			effects: [
				-.01,
				-.03,
				-.05,
				-.08,
				-.1,
				-.15
			],
			effectType: "MarketDiscountPct",
			effectUnit: "pct"
		},
		{
			id: "herkow-plasma-chamber",
			category: "Power",
			tierNames: [
				void 0,
				void 0,
				void 0,
				"H`erkow Plasma Chamber",
				"H`erkow Control Center",
				"H`erkow Orb Reactor"
			],
			effects: [
				void 0,
				void 0,
				void 0,
				.1,
				.15,
				.25
			],
			effectType: "AllArpPct",
			effectUnit: "pct"
		},
		{
			id: "them",
			category: "Power",
			tierNames: [
				"*** THEM ***",
				"*** THEM CONTAINED ***",
				"*** THEM ESCAPED ***",
				void 0,
				void 0,
				void 0
			],
			effects: [
				-.2,
				-.25,
				-.25,
				void 0,
				void 0,
				void 0
			],
			effectType: "AllArpPct",
			effectUnit: "pct"
		},
		{
			id: "herkow-warrior-script",
			category: "Weapon",
			tierNames: [
				"H`erkow Warrior Script",
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effects: [
				1,
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effectType: "SteamQuests",
			effectUnit: "flat"
		},
		{
			id: "scion-of-the-light",
			category: "Tech",
			tierNames: [
				"Scion of the Light",
				"Scion of the Light: 2nd Sighting",
				void 0,
				void 0,
				void 0,
				void 0
			],
			effects: [
				1,
				2,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effectType: "WatchTwitch",
			effectUnit: "flat"
		},
		{
			id: "mysterious-text",
			category: "Language",
			tierNames: [
				"Mysterious Text",
				"Mysterious Text Decipher",
				void 0,
				void 0,
				void 0,
				void 0
			],
			effects: [
				-.01,
				-.02,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effectType: "MarketDiscountPct",
			effectUnit: "pct"
		},
		{
			id: "chai-stones",
			category: "Precious Gems",
			tierNames: [
				"Chai Stones - Raw",
				"Chai Stones - Unprocessed",
				"Chai Stones - Processed",
				"The Stone of Cromcote`",
				"H`erkow Fertility Stone",
				"Chai Stone H`erkow Display"
			],
			effects: [
				1,
				2,
				3,
				4,
				5,
				6
			],
			effectType: "DailyCalendar",
			effectUnit: "flat"
		},
		{
			id: "herkow-fertility-robes",
			category: "Clothing",
			tierNames: [
				void 0,
				void 0,
				void 0,
				"H`erkow Fertility Robes",
				void 0,
				void 0
			],
			effects: [
				void 0,
				void 0,
				void 0,
				"Pink",
				void 0,
				void 0
			],
			effectType: "UsernameColor",
			effectUnit: "cosmetic"
		},
		{
			id: "pn295-unstable-battery",
			category: "Weapon",
			tierNames: [
				"Pn 295 Unstable Battery",
				"Pn 295 Stable Battery",
				"Pn 295 Contained Battery",
				"Pn 295 Battery Amplifier",
				"Pn 295 Cruiser Class Battery Amplifier",
				"Pn 295 Recycler"
			],
			effects: [
				2,
				4,
				6,
				8,
				10,
				15
			],
			effectType: "SteamQuests",
			effectUnit: "flat"
		},
		{
			id: "zorathian-cosmotheque",
			category: "Knowledge",
			tierNames: [
				void 0,
				"Zorathian Cosmotheque",
				"Zorathian Data Mine",
				"5th Dimensional Data",
				"Crystalline Quantum Shelving",
				"Zorathian Library"
			],
			effects: [
				void 0,
				1,
				2,
				3,
				4,
				5
			],
			effectType: "DiscordPoll",
			effectUnit: "flat"
		},
		{
			id: "flux",
			category: "Social",
			tierNames: [
				"Flux",
				"Advanced Flux",
				"Spocot Board",
				"Spocot Flux Epoc",
				"Spocot Flux Final",
				"Spocot Flux Champion"
			],
			effects: [
				.05,
				.1,
				.2,
				.3,
				.4,
				.5
			],
			effectType: "CommunityPlaytimePct",
			effectUnit: "pct"
		},
		{
			id: "bali-arches",
			category: "Architecture",
			tierNames: [
				void 0,
				"Ba'li Arches",
				"Northop Arches",
				"Golden Arches",
				"Apotho Arches",
				"Eye of the Night"
			],
			effects: [
				void 0,
				1,
				2,
				3,
				4,
				6
			],
			effectType: "TimeOnSite",
			effectUnit: "flat"
		},
		{
			id: "gamers-wanted",
			category: "Architecture",
			tierNames: [
				void 0,
				void 0,
				"Gamers Wanted",
				"They're Out There",
				"Defy Boundaries",
				"Rise"
			],
			effects: [
				void 0,
				void 0,
				1,
				2,
				3,
				4
			],
			effectType: "TimeOnSite",
			effectUnit: "flat"
		},
		{
			id: "omniversal-override",
			category: "Language",
			tierNames: [
				void 0,
				void 0,
				"Omniversal Override",
				"Planetary Tranverser",
				"Dimensional Articulator",
				"Multi-Planar Transmuter"
			],
			effects: [
				void 0,
				void 0,
				-.02,
				-.03,
				-.04,
				-.05
			],
			effectType: "MarketDiscountPct",
			effectUnit: "pct"
		},
		{
			id: "the-black-rose",
			category: "Clothing",
			tierNames: [
				"The Black Rose",
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effects: [
				"Dark Gray",
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effectType: "UsernameColor",
			effectUnit: "cosmetic"
		},
		{
			id: "the-fractured-lilly",
			category: "Precious Gems",
			tierNames: [
				"The Fractured Lilly",
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effects: [
				0,
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effectType: "None",
			effectUnit: "flat"
		},
		{
			id: "the-veiled-thorn",
			category: "Weapon",
			tierNames: [
				"The Veiled Thorn",
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effects: [
				0,
				void 0,
				void 0,
				void 0,
				void 0,
				void 0
			],
			effectType: "None",
			effectUnit: "flat"
		},
		{
			id: "audio-archive-stone",
			category: "Clothing",
			tierNames: [
				void 0,
				void 0,
				void 0,
				void 0,
				void 0,
				"Audio Archive Stone"
			],
			effects: [
				void 0,
				void 0,
				void 0,
				void 0,
				void 0,
				"Tomato"
			],
			effectType: "UsernameColor",
			effectUnit: "cosmetic"
		}
	];
	var TIER_NAME_ALIASES = {
		"Pn295 Recycler": {
			id: "pn295-unstable-battery",
			tier: 5
		},
		"H'erkow Warrior Script": {
			id: "herkow-warrior-script",
			tier: 0
		}
	};
	var ARTIFACT_SETS = [
		{
			id: "first-contact",
			name: "First Contact",
			memberIds: [
				"sylphin-fission-blade",
				"pn295",
				"light-warping"
			],
			effects: [{
				type: "DailyCalendar",
				value: 1,
				unit: "flat"
			}, {
				type: "UsernameColor",
				value: 1,
				unit: "cosmetic"
			}]
		},
		{
			id: "stanley-excavation",
			name: "The Stanley Excavation",
			memberIds: [
				"chai-stones",
				"herkow-fertility-robes",
				"pn295-unstable-battery"
			],
			effects: [{
				type: "SteamQuests",
				value: 5,
				unit: "flat"
			}, {
				type: "MarketDiscountPct",
				value: -.15,
				unit: "pct"
			}]
		},
		{
			id: "zorathian-renaissance",
			name: "Zorathian Renaissance",
			memberIds: [
				"zorathian-cosmotheque",
				"flux",
				"bali-arches"
			],
			effects: [{
				type: "AllArpPct",
				value: .1,
				unit: "pct"
			}, {
				type: "UsernameColor",
				value: 1,
				unit: "cosmetic"
			}]
		},
		{
			id: "braxtine-garden",
			name: "Braxtine Garden",
			memberIds: [
				"the-black-rose",
				"the-crimsom-t",
				"the-nebula-c"
			],
			effects: [{
				type: "AllArpPct",
				value: 5,
				unit: "pct"
			}, {
				type: "TimeOnSite",
				value: 100,
				unit: "flat"
			}]
		}
	];
	var BASE_ACTIVITY = {
		days: 1,
		timeOnSiteBasePerDay: 5,
		watchTwitchBasePerDay: 15,
		steamQuestBases: [
			15,
			25,
			25
		],
		discordPollBase: 5,
		discordPollsWhenPending: 2,
		discordPollPostHourUtc: 16,
		dailyQuestBase: 7,
		weekendQuestBase: 5,
		dailyCalendarBasePerDay: 5,
		steamCommunityEventReward: 20
	};
	var MONTHLY_CATEGORY_USES = {
		["WatchTwitch"]: 30,
		["DailyCalendar"]: 30,
		["TimeOnSite"]: 30,
		["SteamQuests"]: 12,
		["DiscordPoll"]: 20
	};
	var MONTHLY_ARP_FOR_PCT = 1800;
	var END_GAME_HPC_UPGRADE_ORDER = [
		"herkow-plasma-chamber",
		"pn295",
		"chai-stones",
		"pn295-unstable-battery",
		"bali-arches",
		"sylphin-fission-blade",
		"zorathian-cosmotheque",
		"scion-of-the-light"
	];
	var END_GAME_NO_HPC_UPGRADE_ORDER = [
		"pn295",
		"chai-stones",
		"pn295-unstable-battery",
		"bali-arches",
		"sylphin-fission-blade",
		"zorathian-cosmotheque",
		"scion-of-the-light"
	];
	var NEW_GAME_UPGRADE_ORDER = [
		"bali-arches",
		"zorathian-cosmotheque",
		"flux",
		"scion-of-the-light"
	];
	function upgradeFocusOrder(ownedFamilyIds) {
		if (ownedFamilyIds.has("herkow-plasma-chamber")) return END_GAME_HPC_UPGRADE_ORDER;
		if (ownedFamilyIds.has("pn295")) return END_GAME_NO_HPC_UPGRADE_ORDER;
		return NEW_GAME_UPGRADE_ORDER;
	}
	var END_GAME_HPC_STANDING = [
		"herkow-plasma-chamber",
		"chai-stones",
		"pn295"
	];
	var END_GAME_NO_HPC_STANDING = [
		"pn295",
		"chai-stones",
		"bali-arches"
	];
	var NEW_GAME_STANDING = [
		"bali-arches",
		"zorathian-cosmotheque",
		"flux"
	];
	function monthlyMetaStandingFamilies(ownedFamilyIds) {
		if (ownedFamilyIds.has("herkow-plasma-chamber")) return {
			standing: END_GAME_HPC_STANDING,
			fillOrder: END_GAME_HPC_UPGRADE_ORDER
		};
		if (ownedFamilyIds.has("pn295")) return {
			standing: END_GAME_NO_HPC_STANDING,
			fillOrder: END_GAME_NO_HPC_UPGRADE_ORDER
		};
		return {
			standing: NEW_GAME_STANDING,
			fillOrder: NEW_GAME_UPGRADE_ORDER
		};
	}
	function getArtifactById(id) {
		return ARTIFACTS.find((a) => a.id === id);
	}
	function listArtifactNameEntries() {
		const seen = new Set();
		const entries = [];
		const push = (name, definition, tier) => {
			if (seen.has(name)) return;
			seen.add(name);
			entries.push({
				name,
				definition,
				tier
			});
		};
		for (const definition of ARTIFACTS) for (const [tier, name] of definition.tierNames.entries()) if (name) push(name, definition, tier);
		for (const [name, alias] of Object.entries(TIER_NAME_ALIASES)) {
			const definition = getArtifactById(alias.id);
			if (definition) push(name, definition, alias.tier);
		}
		return entries.toSorted((left, right) => right.name.length - left.name.length);
	}
	function resolveArtifactByDisplayName(displayName) {
		const alias = TIER_NAME_ALIASES[displayName];
		if (alias) {
			const definition = getArtifactById(alias.id);
			if (definition) return {
				definition,
				tier: alias.tier
			};
		}
		for (const definition of ARTIFACTS) {
			const index = definition.tierNames.findIndex((name) => name?.toLowerCase() === displayName.toLowerCase());
			if (index !== -1) return {
				definition,
				tier: index
			};
		}
		const normalized = normalizeName$1(displayName);
		for (const definition of ARTIFACTS) {
			const index = definition.tierNames.findIndex((name) => name !== void 0 && normalizeName$1(name) === normalized);
			if (index !== -1) return {
				definition,
				tier: index
			};
		}
	}
	function normalizeName$1(name) {
		return name.toLowerCase().replaceAll(/[`'’]/g, "").replaceAll(/\s+/g, " ").trim();
	}
	function getNumericEffect(definition, tier) {
		if (definition.effectUnit === "cosmetic") return 0;
		const value = definition.effects[tier];
		return typeof value === "number" ? value : 0;
	}
	function fragmentCostToUpgradeFrom(tier) {
		if (tier >= 5) return;
		return FRAGMENT_COST_TO_TIER[tier + 1];
	}
	function displayNameFor(definition, tier) {
		return definition.tierNames[tier] ?? definition.id;
	}
	var MS_PER_DAY$2 = 864e5;
	function utcAtHour(date, hour) {
		return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, 0, 0, 0));
	}
	function isUtcWeekday(date) {
		const day = date.getUTCDay();
		return day >= 1 && day <= 5;
	}
	function nextDiscordPollPostAt(now = new Date()) {
		for (let offset = 0; offset <= 7; offset += 1) {
			const post = utcAtHour(new Date(now.getTime() + offset * MS_PER_DAY$2), BASE_ACTIVITY.discordPollPostHourUtc);
			if (isUtcWeekday(post) && post.getTime() > now.getTime()) return post;
		}
		return utcAtHour(now, BASE_ACTIVITY.discordPollPostHourUtc);
	}
	function lastDiscordPollPostAt(now = new Date()) {
		for (let offset = 0; offset <= 7; offset += 1) {
			const post = utcAtHour(new Date(now.getTime() - offset * MS_PER_DAY$2), BASE_ACTIVITY.discordPollPostHourUtc);
			if (isUtcWeekday(post) && post.getTime() <= now.getTime()) return post;
		}
		return utcAtHour(now, BASE_ACTIVITY.discordPollPostHourUtc);
	}
	function msUntilNextDiscordPollPost(now = new Date()) {
		return Math.max(0, nextDiscordPollPostAt(now).getTime() - now.getTime());
	}
	var STEAM_QUEST_STATUS_ID_PREFIX = "control-center__steam-quest-status-";
	var STEAM_LIBRARY_SYNC_LABEL = /^(Check Game|Visit Steam|Sync Games)$/i;
	var STEAM_OWNERSHIP_DENIAL = /do not own|don['’]t own|not in your steam library|not in your library|must own this game/i;
	function hasSteamLibrarySyncControl(document_) {
		if (document_.querySelector(".btn-check-owned-games")) return true;
		return [...document_.querySelectorAll("a, button")].some((element) => STEAM_LIBRARY_SYNC_LABEL.test(controlLabel(element)));
	}
	function hasSteamOwnershipDenialText(document_) {
		return STEAM_OWNERSHIP_DENIAL.test(pageText(document_));
	}
	function isChooseYourOwnGameQuest(quest) {
		return /choose[- ]your[- ]own[- ]game/i.test(`${quest.name} ${quest.href ?? ""}`);
	}
	function steamQuestStatusFromText(text) {
		const trimmed = text.trim();
		if (/^complete$/i.test(trimmed)) return "complete";
		if (/^incomplete$/i.test(trimmed)) return "incomplete";
	}
	function steamQuestEligibilityFromStatusText(text, quest) {
		if (/unavailable|ineligible|locked|not owned|unowned/i.test(text.trim())) return "ineligible";
		if (isChooseYourOwnGameQuest(quest)) return "eligible";
		return "unknown";
	}
	function parseSteamQuestRewardArp(text) {
		const compact = text.replaceAll(",", "");
		const arpAt = compact.toUpperCase().indexOf(" ARP");
		if (arpAt === -1) return;
		const amountToken = compact.slice(0, arpAt).trim().split(" ").at(-1);
		const reward = Number(amountToken);
		return Number.isFinite(reward) && reward > 0 ? reward : void 0;
	}
	function pathnameFromHref$1(href) {
		if (!href) return;
		try {
			return new URL(href, "https://na.alienwarearena.com").pathname;
		} catch {
			return href.startsWith("/") ? href : void 0;
		}
	}
	function buildSteamQuestRow(options) {
		const { name, href, rewardArp, statusText, id } = options;
		const identity = {
			name,
			...href && { href }
		};
		const status = steamQuestStatusFromText(statusText) ?? "incomplete";
		const row = {
			name,
			rewardArp,
			status,
			eligibility: status === "complete" ? "eligible" : steamQuestEligibilityFromStatusText(statusText, identity)
		};
		if (id) row.id = id;
		if (href) row.href = href;
		return row;
	}
	function parseSteamQuestRowFromStatusCell(card, statusCell) {
		const id = statusCell.id.startsWith(STEAM_QUEST_STATUS_ID_PREFIX) ? statusCell.id.slice(35) : void 0;
		const row = statusCell.closest("tr") ?? statusCell.parentElement;
		if (!row) return;
		const questLink = row.querySelector("a[href*=\"/steam/quests/\"]");
		const name = questLink?.textContent?.replaceAll(/\s+/g, " ").trim() || row.querySelector("a")?.textContent?.replaceAll(/\s+/g, " ").trim();
		if (!name) return;
		const rewardArp = parseSteamQuestRewardArp((id ? card.querySelector(`#control-center__steam-quest-reward-${id}`) : void 0)?.textContent ?? row.textContent ?? "");
		if (rewardArp === void 0) return;
		const href = pathnameFromHref$1(questLink?.getAttribute("href") ?? void 0);
		return buildSteamQuestRow({
			name,
			rewardArp,
			statusText: statusCell.textContent?.trim() ?? "",
			...id && { id },
			...href && { href }
		});
	}
	function parseSteamQuestRowFromTableRow(row) {
		const questLink = row.querySelector("a[href*=\"/steam/quests/\"]");
		const name = questLink?.textContent?.replaceAll(/\s+/g, " ").trim();
		if (!name) return;
		const rewardArp = parseSteamQuestRewardArp(row.textContent ?? "");
		if (rewardArp === void 0) return;
		const statusCell = [...row.querySelectorAll("td")].find((cell) => steamQuestStatusFromText(cell.textContent ?? ""));
		const href = pathnameFromHref$1(questLink?.getAttribute("href") ?? void 0);
		return buildSteamQuestRow({
			name,
			rewardArp,
			statusText: statusCell?.textContent?.trim() ?? "",
			...href && { href }
		});
	}
	function scrapeSteamQuestRowsFromDocument(document_) {
		const card = findActivityCard(document_, /^Steam Quests$/i);
		if (!card) return [];
		const fromStatusIds = [...card.querySelectorAll("[id^=\"control-center__steam-quest-status-\"]")].map((cell) => parseSteamQuestRowFromStatusCell(card, cell)).filter((row) => row !== void 0);
		if (fromStatusIds.length > 0) return fromStatusIds;
		return [...card.querySelectorAll("tr")].map((row) => parseSteamQuestRowFromTableRow(row)).filter((row) => row !== void 0);
	}
	function steamQuestsCapFromRows(quests) {
		if (quests.length === 0) return;
		return remainingSteamQuestRowsFromList(quests).length > 0 ? "available" : "capped";
	}
	function steamQuestRowKey(row) {
		return row.id ?? row.href ?? row.name.toLowerCase();
	}
	function mergeSteamQuestRows(scraped, previous) {
		if (!previous || previous.length === 0) return scraped;
		const priorByKey = new Map(previous.map((row) => [steamQuestRowKey(row), row]));
		return scraped.map((row) => {
			const prior = priorByKey.get(steamQuestRowKey(row));
			if (!prior) return row;
			if (row.eligibility !== "unknown" || prior.status !== row.status) return row;
			const merged = {
				...row,
				eligibility: prior.eligibility
			};
			if (prior.steamAppId !== void 0) merged.steamAppId = prior.steamAppId;
			if (prior.isFree !== void 0) merged.isFree = prior.isFree;
			if (prior.libraryPending === true) merged.libraryPending = true;
			return merged;
		});
	}
	function remainingSteamQuestRowsFromList(quests) {
		return quests.filter((quest) => quest.status === "incomplete" && quest.eligibility !== "ineligible");
	}
	function remainingSteamQuestRows(siteState) {
		return remainingSteamQuestRowsFromList(siteState.steamQuests?.quests ?? []);
	}
	function remainingSteamQuestRewards(siteState) {
		const scraped = scrapedRemainingSteamQuestRewards(siteState);
		if (scraped !== void 0) return scraped;
		return [...BASE_ACTIVITY.steamQuestBases];
	}
	function scrapedRemainingSteamQuestRewards(siteState) {
		const quests = siteState.steamQuests?.quests;
		if (!quests || quests.length === 0) return;
		return remainingSteamQuestRowsFromList(quests).map((quest) => quest.rewardArp);
	}
	function requiresSteamQuestEligibilityFetch(state) {
		return (state.steamQuests?.quests ?? []).some((quest) => {
			if (quest.status !== "incomplete" || !quest.href || isChooseYourOwnGameQuest(quest)) return false;
			if (quest.eligibility === "unknown") return true;
			return quest.eligibility === "ineligible" && quest.isFree === void 0;
		});
	}
	function scrapeSteamPlayEligibilityFromDocument(document_, options = {}) {
		if ((options.personalHours ?? 0) > 0) return "eligible";
		if (options.href && isChooseYourOwnGameQuest({
			name: "",
			href: options.href
		})) return "eligible";
		const body = pageText(document_);
		if (/completed this quest/i.test(body)) return "eligible";
		if (document_.querySelector(".btn-start-quest, a[href^=\"steam://\"]")) return "eligible";
		if ([...document_.querySelectorAll("a, button")].some((element) => /^Launch Game$/i.test(controlLabel(element)))) return "eligible";
		const progress = document_.querySelector(":scope .progress-steam-quest [aria-valuenow]");
		const played = Number(progress?.getAttribute("aria-valuenow") ?? "");
		if (Number.isFinite(played) && played > 0) return "eligible";
		if (hasSteamLibrarySyncControl(document_) || hasSteamOwnershipDenialText(document_)) return "ineligible";
		return "unknown";
	}
	function applySteamQuestsFromDocument(next, document_) {
		const scraped = scrapeSteamQuestRowsFromDocument(document_);
		if (scraped.length === 0) return;
		const quests = mergeSteamQuestRows(scraped, next.steamQuests?.quests);
		next.steamQuests = {
			scrapedAt: new Date().toISOString(),
			quests
		};
		const cap = steamQuestsCapFromRows(quests);
		if (cap) next.caps.steamQuests = cap;
	}
	function applySteamQuestDetailFromDocument(next, document_, pagePath) {
		const quests = [...next.steamQuests?.quests ?? []];
		if (quests.length === 0) return;
		const index = quests.findIndex((quest) => quest.href && pagePath.includes(quest.href));
		if (index === -1) return;
		const current = quests[index];
		if (!current) return;
		const isQuestComplete = /completed this quest/i.test(pageText(document_));
		const scrapedEligibility = scrapeSteamPlayEligibilityFromDocument(document_, current.href ? { href: current.href } : {});
		let eligibility = scrapedEligibility;
		if (isQuestComplete) eligibility = "eligible";
		else if (scrapedEligibility === "unknown") eligibility = current.eligibility;
		const steamAppId = scrapeSteamAppIdFromDocument(document_) ?? current.steamAppId;
		const updated = {
			...current,
			eligibility,
			status: isQuestComplete ? "complete" : current.status
		};
		if (steamAppId !== void 0) updated.steamAppId = steamAppId;
		quests[index] = updated;
		next.steamQuests = {
			scrapedAt: new Date().toISOString(),
			quests
		};
		const cap = steamQuestsCapFromRows(quests);
		if (cap) next.caps.steamQuests = cap;
	}
	function canEarnCommunityEventArp(event) {
		return event?.playEligibility !== "ineligible";
	}
	function scrapeLiveCommunityEventBanner(document_) {
		const bannerLink = document_.querySelector(":scope a.community-event-banner") ?? document_.querySelector(":scope .community-event-banner a[href*='/steam/community-event/']") ?? [...document_.querySelectorAll(":scope a[href*='/steam/community-event/']")].find((link) => /LIVE/i.test(link.textContent ?? ""));
		if (!bannerLink?.href) return;
		const path = bannerLink.pathname || bannerLink.getAttribute("href") || "";
		if (!path.includes("/steam/community-event/")) return;
		const title = bannerLink.textContent?.replaceAll(/\s+/g, " ").trim();
		const result = { url: path };
		if (title) result.title = title;
		return result;
	}
	function isCommunityGateMet(milestone, communityHours) {
		if (milestone.isCommunityUnlocked) return true;
		const required = milestone.communityHoursRequired;
		return required !== void 0 && communityHours !== void 0 && communityHours >= required;
	}
	function applyCommunityHoursUnlocks(milestones, communityHours) {
		if (communityHours === void 0) return milestones;
		return milestones.map((milestone) => {
			if (isCommunityGateMet(milestone, communityHours)) return milestone.isCommunityUnlocked ? milestone : {
				...milestone,
				isCommunityUnlocked: true
			};
			return milestone;
		});
	}
	function milestoneSortKey(milestone) {
		return milestone.communityHoursRequired ?? milestone.index;
	}
	function applySequentialCommunityAwards(milestones) {
		let lastAwardedKey = Number.NEGATIVE_INFINITY;
		for (const milestone of milestones) {
			if (!milestone.isAwarded) continue;
			const key = milestoneSortKey(milestone);
			if (key > lastAwardedKey) lastAwardedKey = key;
		}
		if (lastAwardedKey === Number.NEGATIVE_INFINITY) return milestones;
		return milestones.map((milestone) => {
			if (milestone.isAwarded || milestoneSortKey(milestone) >= lastAwardedKey) return milestone;
			return {
				...milestone,
				isAwarded: true,
				isCommunityUnlocked: true
			};
		});
	}
	function personalHoursFromMilestones(milestones, scrapedHours) {
		let hours = scrapedHours;
		for (const milestone of milestones) if (milestone.isAwarded && milestone.personalHoursRequired > hours) hours = milestone.personalHoursRequired;
		return hours;
	}
	function isPersonalHoursMet(milestone, personalHours) {
		return milestone.personalHoursRequired <= personalHours;
	}
	function isCommunityEventMilestonePending(milestone, personalHours, communityHours) {
		if (milestone.isAwarded || milestone.arpReward <= 0) return false;
		return isPersonalHoursMet(milestone, personalHours) || isCommunityGateMet(milestone, communityHours);
	}
	function computePendingCommunityEventArp(personalHours, milestones, communityHours) {
		return milestones.filter((milestone) => isCommunityEventMilestonePending(milestone, personalHours, communityHours)).reduce((sum, milestone) => sum + milestone.arpReward, 0);
	}
	function breakDownCommunityEventPending(event) {
		let imminentArp = 0;
		let waitingCommunityArp = 0;
		let waitingPersonalArp = 0;
		let pendingCount = 0;
		for (const milestone of event.milestones) {
			if (!isCommunityEventMilestonePending(milestone, event.personalHours, event.communityHours)) continue;
			pendingCount += 1;
			const isPersonalMet = isPersonalHoursMet(milestone, event.personalHours);
			if (isPersonalMet && isCommunityGateMet(milestone, event.communityHours)) imminentArp += milestone.arpReward;
			else if (isPersonalMet) waitingCommunityArp += milestone.arpReward;
			else waitingPersonalArp += milestone.arpReward;
		}
		return {
			imminentArp,
			waitingCommunityArp,
			waitingPersonalArp,
			pendingCount
		};
	}
	function formatCommunityEventArp(baseArp, allArpPct = 0) {
		if (allArpPct > 0) return `~${Math.round(baseArp * (1 + allArpPct))} ARP`;
		return `${baseArp} ARP`;
	}
	function describeWaitingPersonalArp(event, waitingPersonalArp, allArpPct) {
		const unmet = event.milestones.filter((milestone) => !milestone.isAwarded && milestone.arpReward > 0 && isCommunityGateMet(milestone, event.communityHours) && !isPersonalHoursMet(milestone, event.personalHours));
		let needHours = 0;
		for (const milestone of unmet) if (milestone.personalHoursRequired > needHours) needHours = milestone.personalHoursRequired;
		const moreHours = Math.max(0, needHours - event.personalHours);
		const head = formatCommunityEventArp(waitingPersonalArp, allArpPct);
		if (moreHours <= 0 || needHours <= 0) return `${head} unlocked — not awarded yet`;
		return `${head} unlocked — play ${moreHours}h more (${event.personalHours}h / ${needHours}h)`;
	}
	function describeCommunityEventPendingParts(event, allArpPct = 0) {
		const { imminentArp, waitingCommunityArp, waitingPersonalArp } = breakDownCommunityEventPending(event);
		const nextLocked = nextLockedCommunityArpMilestone(event);
		if (nextLocked === void 0 && imminentArp <= 0 && waitingCommunityArp <= 0 && waitingPersonalArp <= 0) return { text: "no unawarded ARP remaining" };
		const parts = [];
		let later;
		if (waitingPersonalArp > 0) parts.push(describeWaitingPersonalArp(event, waitingPersonalArp, allArpPct));
		const lockedArp = waitingCommunityArp > 0 ? waitingCommunityArp : nextLocked?.arpReward ?? 0;
		if (lockedArp > 0) {
			const waiting = describeWaitingCommunityArp(event, lockedArp, allArpPct);
			parts.push(waiting.text);
			later = waiting.later;
		}
		if (imminentArp > 0) parts.push(`${formatCommunityEventArp(imminentArp, allArpPct)} unlocked — not awarded yet`);
		if (parts.length === 0) return { text: "no unawarded ARP remaining" };
		return later ? {
			text: parts.join("; "),
			later
		} : { text: parts.join("; ") };
	}
	var COMMUNITY_SAMPLE_MAX = 96;
	var COMMUNITY_SAMPLE_VISIT_MIN_GAP_MS = 9e5;
	var COMMUNITY_HOURS_REMOTE_SAMPLE_MIN_MS = 36e5;
	var COMMUNITY_RATE_MIN_SPAN_MS = 9e5;
	var COMMUNITY_RATE_WINDOW_MS = 864e5;
	var COMMUNITY_TREND_WINDOW_MS = 1728e5;
	var COMMUNITY_TREND_HALF_MIN_MS = 648e5;
	var COMMUNITY_RATIO_MIN = .5;
	var COMMUNITY_RATIO_MAX = 2;
	var COMMUNITY_DECAY_TRUST = .5;
	var COMMUNITY_RATIO_FLAT_EPS = .03;
	var COMMUNITY_MAX_HOURS_PER_DAY = 8e4;
	function markCommunityEventEnded(event) {
		return {
			scrapedAt: event.scrapedAt,
			url: event.url,
			isLive: false,
			personalHours: event.personalHours,
			milestones: event.milestones,
			pendingArp: 0,
			awardedArp: event.awardedArp,
			...event.title !== void 0 && { title: event.title },
			...event.receivedArpFromLog !== void 0 && { receivedArpFromLog: event.receivedArpFromLog }
		};
	}
	function shouldSkipCommunityHoursSample(options) {
		const { source, gapMs, hours, lastHours } = options;
		if (source === "remote") return gapMs < COMMUNITY_HOURS_REMOTE_SAMPLE_MIN_MS;
		return gapMs < COMMUNITY_SAMPLE_VISIT_MIN_GAP_MS && hours === lastHours;
	}
	function appendCommunityHoursSample(samples, hours, atIso = new Date().toISOString(), source = "visit") {
		const atMs = Date.parse(atIso);
		if (!Number.isFinite(hours) || hours < 0 || Number.isNaN(atMs)) return samples;
		const next = [...samples];
		const last = next.at(-1);
		if (last) {
			if (hours + 1 < last.hours) return [{
				at: atIso,
				hours
			}];
			const lastMs = Date.parse(last.at);
			if (Number.isFinite(lastMs) && shouldSkipCommunityHoursSample({
				source,
				gapMs: atMs - lastMs,
				hours,
				lastHours: last.hours
			})) return next;
		}
		next.push({
			at: atIso,
			hours
		});
		if (next.length > COMMUNITY_SAMPLE_MAX) return next.slice(-96);
		return next;
	}
	function isSparseCommunityEventScrape(scraped, previous) {
		return scraped.isLive && previous?.isLive === true && previous.milestones.length > 0 && scraped.milestones.length === 0;
	}
	function mergeCommunityEventScrape(scraped, previous, options = {}) {
		if (previous && isSparseCommunityEventScrape(scraped, previous)) return previous;
		return mergeLiveCommunityEventScrape(scraped, previous, options);
	}
	function mergeLiveCommunityEventScrape(scraped, previous, options = {}) {
		if (!scraped.isLive) return markCommunityEventEnded(previous?.url === scraped.url ? {
			...previous,
			...scraped,
			isLive: false,
			pendingArp: 0
		} : scraped);
		const source = options.source ?? "visit";
		const sameEvent = previous && (previous.url === scraped.url || previous.title !== void 0 && scraped.title !== void 0 && previous.title === scraped.title);
		const hasAsceHistory = Boolean(sameEvent) && previous?.communityHoursSource === "asce";
		let samples = sameEvent ? [...previous.communityHoursSamples ?? []] : [];
		if (!hasAsceHistory && scraped.communityHours !== void 0) samples = appendCommunityHoursSample(samples, scraped.communityHours, scraped.scrapedAt, source);
		const merged = { ...scraped };
		if (samples.length > 0) merged.communityHoursSamples = samples;
		if (hasAsceHistory) merged.communityHoursSource = "asce";
		return carryForwardCommunityEventFields(merged, previous, Boolean(sameEvent));
	}
	function milestoneMergeKey(milestone) {
		return milestone.communityHoursRequired === void 0 ? `i:${milestone.index}` : `h:${milestone.communityHoursRequired}`;
	}
	function preferCommunityEventMilestone(scraped, previous) {
		if (!previous) return scraped;
		const arpReward = scraped.arpReward > 0 ? scraped.arpReward : previous.arpReward;
		const next = {
			...previous,
			...scraped,
			arpReward,
			isAwarded: scraped.arpReward > 0 ? scraped.isAwarded : previous.isAwarded,
			isCommunityUnlocked: scraped.isCommunityUnlocked || previous.isCommunityUnlocked
		};
		if (scraped.arpReward <= 0 && previous.arpReward > 0) next.rewardLabel = previous.rewardLabel;
		if (scraped.communityHoursRequired === void 0 && previous.communityHoursRequired !== void 0) next.communityHoursRequired = previous.communityHoursRequired;
		if (scraped.personalHoursRequired <= 0 && previous.personalHoursRequired > 0) next.personalHoursRequired = previous.personalHoursRequired;
		return next;
	}
	function mergeCommunityEventMilestones(scraped, previous) {
		if (!previous || previous.length === 0) return scraped;
		const merged = new Map();
		const previousByIndex = new Map();
		for (const milestone of previous) {
			merged.set(milestoneMergeKey(milestone), milestone);
			previousByIndex.set(milestone.index, milestone);
		}
		for (const milestone of scraped) {
			const key = milestoneMergeKey(milestone);
			const previousMatch = merged.get(key) ?? (milestone.communityHoursRequired === void 0 ? previousByIndex.get(milestone.index) : void 0);
			if (previousMatch) merged.delete(milestoneMergeKey(previousMatch));
			const next = preferCommunityEventMilestone(milestone, previousMatch);
			merged.set(milestoneMergeKey(next), next);
		}
		return merged.values().toArray().toSorted((left, right) => (left.communityHoursRequired ?? left.index) - (right.communityHoursRequired ?? right.index));
	}
	function inferPersonalHoursRequired(existing) {
		const known = existing.filter((milestone) => milestone.arpReward > 0).map((milestone) => milestone.personalHoursRequired);
		if (known.length === 0) return 1;
		return Math.max(...known);
	}
	function splitMilestonesByHours(existing) {
		const byHours = new Map();
		const withoutHours = [];
		for (const milestone of existing) {
			const hours = milestone.communityHoursRequired;
			if (hours === void 0) withoutHours.push(milestone);
			else byHours.set(hours, milestone);
		}
		return {
			byHours,
			withoutHours
		};
	}
	function nextMilestoneIndex(existing) {
		let nextIndex = 1;
		for (const milestone of existing) if (milestone.index >= nextIndex) nextIndex = milestone.index + 1;
		return nextIndex;
	}
	function patchMilestoneFromGate(current, gate) {
		const isUnlocking = gate.unlocked && !current.isCommunityUnlocked;
		const isFillingArp = current.arpReward <= 0 && gate.arpReward > 0;
		if (!isUnlocking && !isFillingArp) return current;
		return {
			...current,
			...isUnlocking && { isCommunityUnlocked: true },
			...isFillingArp && {
				arpReward: gate.arpReward,
				rewardLabel: gate.label
			}
		};
	}
	function upsertCommunityEventMilestoneGates(existing, gates) {
		if (gates.length === 0) return existing;
		const { byHours, withoutHours } = splitMilestonesByHours(existing);
		const inferredPersonal = inferPersonalHoursRequired(existing);
		let nextIndex = nextMilestoneIndex(existing);
		for (const gate of gates) {
			const current = byHours.get(gate.hours);
			if (current) {
				byHours.set(gate.hours, patchMilestoneFromGate(current, gate));
				continue;
			}
			byHours.set(gate.hours, {
				index: nextIndex,
				personalHoursRequired: inferredPersonal,
				communityHoursRequired: gate.hours,
				arpReward: gate.arpReward,
				rewardLabel: gate.label,
				isCommunityUnlocked: gate.unlocked,
				isAwarded: false
			});
			nextIndex += 1;
		}
		return [...withoutHours, ...byHours.values()].toSorted((left, right) => (left.communityHoursRequired ?? left.index) - (right.communityHoursRequired ?? right.index));
	}
	function carryForwardCommunityEventFields(merged, previous, isSameEvent) {
		const next = { ...merged };
		if (previous && isSameEvent && merged.personalHours <= 0 && previous.personalHours > 0) next.personalHours = previous.personalHours;
		if (isSameEvent && previous) {
			next.milestones = applySequentialCommunityAwards(applyCommunityHoursUnlocks(mergeCommunityEventMilestones(next.milestones, previous.milestones), next.communityHours));
			next.personalHours = personalHoursFromMilestones(next.milestones, next.personalHours);
			next.pendingArp = computePendingCommunityEventArp(next.personalHours, next.milestones, next.communityHours);
		}
		if (next.personalHours > 0 || isSameEvent && previous?.playEligibility === "eligible" && merged.playEligibility !== "ineligible") next.playEligibility = "eligible";
		if (isSameEvent && previous?.communityHoursSource === "asce" && previous.communityHours !== void 0 && (next.communityHours === void 0 || next.communityHours < previous.communityHours)) {
			next.communityHours = previous.communityHours;
			next.communityHoursSource = "asce";
		}
		if (next.steamAppId === void 0 && previous?.steamAppId !== void 0) next.steamAppId = previous.steamAppId;
		if (next.isFree === void 0 && previous?.isFree !== void 0) next.isFree = previous.isFree;
		return next;
	}
	function lockedCommunityArpMilestones(event) {
		return event.milestones.filter((milestone) => {
			if (milestone.isAwarded || milestone.arpReward <= 0) return false;
			if (milestone.communityHoursRequired === void 0) return false;
			return !isCommunityGateMet(milestone, event.communityHours);
		}).toSorted((left, right) => (left.communityHoursRequired ?? Number.POSITIVE_INFINITY) - (right.communityHoursRequired ?? Number.POSITIVE_INFINITY));
	}
	function nextLockedCommunityArpMilestone(event) {
		return lockedCommunityArpMilestones(event)[0];
	}
	function waitingCommunityMilestones(event) {
		return lockedCommunityArpMilestones(event).filter((milestone) => isPersonalHoursMet(milestone, event.personalHours));
	}
	function nextCommunityUnlockTarget(event) {
		return nextLockedCommunityArpMilestone(event)?.communityHoursRequired;
	}
	function estimateCommunityUnlockAt(event, targetHours, nowMs = Date.now()) {
		const currentHours = event.communityHours;
		if (currentHours === void 0) return;
		const hoursRemaining = targetHours - currentHours;
		if (hoursRemaining <= 0) return {
			targetHours,
			hoursRemaining: 0,
			hoursPerDay: 0,
			etaMs: 0,
			sampleCount: event.communityHoursSamples?.length ?? 0
		};
		const samples = event.communityHoursSamples ?? [];
		const rate = estimateCommunityHoursPerMs(samples, nowMs);
		if (rate === void 0 || rate <= 0) return;
		const hoursPerDay = rate * 864e5;
		if (hoursPerDay > COMMUNITY_MAX_HOURS_PER_DAY) return;
		const end = samples.at(-1);
		const measuredRatio = end ? communityDayOverDayRatio(samples, end) : void 0;
		return {
			targetHours,
			hoursRemaining,
			hoursPerDay,
			etaMs: communityEtaMs(hoursRemaining, rate, measuredRatio === void 0 ? 1 : optimisticCommunityRatio(measuredRatio)),
			sampleCount: samples.length
		};
	}
	function estimateNextCommunityUnlock(event, nowMs = Date.now()) {
		const targetHours = nextCommunityUnlockTarget(event);
		if (targetHours === void 0) return;
		return estimateCommunityUnlockAt(event, targetHours, nowMs);
	}
	function parseCommunitySampleMs(sample) {
		const ms = Date.parse(sample.at);
		return Number.isFinite(ms) ? ms : void 0;
	}
	function sampleAtOrBefore(samples, tMs) {
		let best;
		let bestMs = Number.NEGATIVE_INFINITY;
		for (const sample of samples) {
			const ms = parseCommunitySampleMs(sample);
			if (ms !== void 0 && ms <= tMs && ms >= bestMs) {
				best = sample;
				bestMs = ms;
			}
		}
		return best;
	}
	function communityHoursPerMsBetween(start, end) {
		const startMs = parseCommunitySampleMs(start);
		const endMs = parseCommunitySampleMs(end);
		if (startMs === void 0 || endMs === void 0 || endMs - startMs < 12e4) return;
		const deltaHours = end.hours - start.hours;
		if (deltaHours <= 0) return;
		return deltaHours / (endMs - startMs);
	}
	function estimateCommunityHoursPerMs(samples, nowMs) {
		if (samples.length < 2) return;
		const end = samples.at(-1);
		if (!end) return;
		const endMs = parseCommunitySampleMs(end);
		if (endMs === void 0 || nowMs - endMs > 2592e5) return;
		const windowStart = sampleAtOrBefore(samples, endMs - COMMUNITY_RATE_WINDOW_MS);
		const fromWindow = windowStart ? communityHoursPerMsBetween(windowStart, end) : void 0;
		if (fromWindow !== void 0) return fromWindow;
		const first = samples.at(0);
		if (first && first !== end) {
			const fromHistory = communityHoursPerMsBetween(first, end);
			if (fromHistory !== void 0) {
				const startMs = parseCommunitySampleMs(first);
				if (startMs !== void 0 && endMs - startMs >= COMMUNITY_RATE_MIN_SPAN_MS) return fromHistory;
			}
		}
		const previous = samples.at(-2);
		return previous ? communityHoursPerMsBetween(previous, end) : void 0;
	}
	function communityDayOverDayRatio(samples, end) {
		const endMs = parseCommunitySampleMs(end);
		if (endMs === void 0) return;
		const mid = sampleAtOrBefore(samples, endMs - COMMUNITY_RATE_WINDOW_MS);
		const start = sampleAtOrBefore(samples, endMs - COMMUNITY_TREND_WINDOW_MS);
		if (!mid || !start || start === mid || mid === end) return;
		const midMs = parseCommunitySampleMs(mid);
		const startMs = parseCommunitySampleMs(start);
		if (midMs === void 0 || startMs === void 0 || endMs - midMs < COMMUNITY_TREND_HALF_MIN_MS || midMs - startMs < COMMUNITY_TREND_HALF_MIN_MS) return;
		const recent = communityHoursPerMsBetween(mid, end);
		const previous = communityHoursPerMsBetween(start, mid);
		if (recent === void 0 || previous === void 0 || previous <= 0) return;
		const ratio = recent / previous;
		if (!Number.isFinite(ratio)) return;
		return Math.min(COMMUNITY_RATIO_MAX, Math.max(COMMUNITY_RATIO_MIN, ratio));
	}
	function optimisticCommunityRatio(measured) {
		if (measured >= 1) return measured;
		return 1 - (1 - measured) * COMMUNITY_DECAY_TRUST;
	}
	function communityEtaMs(remainingHours, ratePerMs, dailyRatio) {
		const linearMs = remainingHours / ratePerMs;
		if (Math.abs(dailyRatio - 1) < COMMUNITY_RATIO_FLAT_EPS) return linearMs;
		const ratePerDay = ratePerMs * 864e5;
		const lnRatio = Math.log(dailyRatio);
		const root = 1 + remainingHours * lnRatio / ratePerDay;
		if (root <= 0) return linearMs;
		const days = Math.log(root) / lnRatio;
		if (!Number.isFinite(days) || days <= 0) return linearMs;
		return days * 864e5;
	}
	function formatCommunityEta(etaMs) {
		if (etaMs <= 0) return "now";
		const totalMinutes = Math.round(etaMs / 6e4);
		if (totalMinutes < 60) return `~${Math.max(1, totalMinutes)}m`;
		const totalHours = Math.round(etaMs / 36e5);
		if (totalHours < 48) return `~${totalHours}h`;
		return `~${(totalHours / 24).toFixed(1)}d`;
	}
	function describeWaitingCommunityProgress(event) {
		const eta = estimateNextCommunityUnlock(event);
		const target = eta?.targetHours ?? nextCommunityUnlockTarget(event);
		const parts = [];
		if (target !== void 0 && event.communityHours !== void 0) parts.push(`${Math.round(event.communityHours).toLocaleString()}/${target.toLocaleString()}h`);
		else if (event.communityHours !== void 0) parts.push(`${Math.round(event.communityHours).toLocaleString()}h`);
		if (eta) parts.push(`ETA ${formatCommunityEta(eta.etaMs)}`);
		return parts.join(" · ");
	}
	function describeWaitingCommunityArp(event, waitingCommunityArp, allArpPct = 0) {
		const locked = lockedCommunityArpMilestones(event);
		const next = locked[0];
		const progress = describeWaitingCommunityProgress(event);
		const nextArp = next?.arpReward ?? 0;
		const laterArp = locked.slice(1).reduce((sum, milestone) => sum + milestone.arpReward, 0);
		const head = formatCommunityEventArp(nextArp > 0 ? nextArp : waitingCommunityArp, allArpPct);
		const later = nextArp > 0 && laterArp > 0 ? `+${formatCommunityEventArp(laterArp, allArpPct)} later` : void 0;
		const text = progress ? `${head} · ${progress}` : `${head} on community unlock`;
		return later ? {
			text,
			later
		} : { text };
	}
	function describeWaitingCommunityArpLine(event, waitingCommunityArp, allArpPct = 0) {
		const { text, later } = describeWaitingCommunityArp(event, waitingCommunityArp, allArpPct);
		return later ? `${text} (${later})` : text;
	}
	function computeAwardedCommunityEventArp(milestones) {
		return milestones.filter((milestone) => milestone.isAwarded && milestone.arpReward > 0).reduce((sum, milestone) => sum + milestone.arpReward, 0);
	}
	function isCommunityEventRewardAction(action) {
		return /Steam Community Event Reward/i.test(action);
	}
	function sumCommunityEventRewardsFromArpLog(arpLog) {
		if (!arpLog) return 0;
		return arpLog.recent.filter((entry) => isCommunityEventRewardAction(entry.action)).reduce((sum, entry) => sum + entry.arp, 0);
	}
	function reconcileCommunityEventWithArpLog(event, arpLog) {
		const receivedArpFromLog = sumCommunityEventRewardsFromArpLog(arpLog);
		const milestones = event.milestones.map((milestone) => ({
			...milestone,
			isCommunityUnlocked: milestone.isCommunityUnlocked || milestone.isAwarded
		})).toSorted((left, right) => left.index - right.index);
		let remainingReceived = receivedArpFromLog;
		for (const milestone of milestones) if (milestone.isAwarded && milestone.arpReward > 0) remainingReceived = Math.max(0, remainingReceived - milestone.arpReward);
		for (const milestone of milestones) {
			if (milestone.isAwarded || milestone.arpReward <= 0 || !isPersonalHoursMet(milestone, event.personalHours) || remainingReceived < milestone.arpReward) continue;
			milestone.isAwarded = true;
			milestone.isCommunityUnlocked = true;
			remainingReceived -= milestone.arpReward;
		}
		const nextMilestones = applySequentialCommunityAwards(milestones);
		const hours = personalHoursFromMilestones(nextMilestones, event.personalHours);
		const next = {
			...event,
			personalHours: hours,
			milestones: nextMilestones,
			pendingArp: computePendingCommunityEventArp(hours, nextMilestones, event.communityHours),
			awardedArp: computeAwardedCommunityEventArp(nextMilestones)
		};
		if (receivedArpFromLog > 0) next.receivedArpFromLog = receivedArpFromLog;
		return next;
	}
	function parseLabeledHours(text, label) {
		const marker = `${label}: `;
		const start = text.indexOf(marker);
		if (start === -1) return;
		const slice = text.slice(start + marker.length);
		const match = /^([\d.]+)/.exec(slice);
		return match?.[1] ? Number(match[1]) : void 0;
	}
	function parseLeadingCount(text, unit) {
		const unitIndex = text.indexOf(` ${unit}`);
		if (unitIndex === -1) return;
		const token = text.slice(0, unitIndex).trim().split(" ").pop();
		const value = token ? Number(token) : NaN;
		return Number.isFinite(value) ? value : void 0;
	}
	function isLabeledRowComplete(cell, label) {
		const needle = `${label}:`;
		const other = label === "Personal" ? "Community:" : "Personal:";
		const scope = [...cell.querySelectorAll("p, div, li, span, tr, td")].find((node) => {
			const text = node.textContent ?? "";
			return text.includes(needle) && !text.includes(other);
		}) ?? [...cell.querySelectorAll("p, div, li, span, tr, td")].find((node) => (node.textContent ?? "").includes(needle)) ?? cell;
		if (scope.querySelector(".fa-check, .fa-check-circle, .bi-check, .bi-check-lg")) return true;
		return /[✓✔]/.test(scope.textContent ?? "");
	}
	function milestoneCellText(cell) {
		const parts = [cell.textContent ?? ""];
		const sibling = cell.nextElementSibling;
		if (sibling && !sibling.classList.contains("carousel-cell")) parts.push(sibling.textContent ?? "");
		return parts.join(" ").replaceAll(/\s+/g, " ").trim();
	}
	function parseMilestoneCell(cell) {
		const text = milestoneCellText(cell);
		const milestoneMarker = text.indexOf("Milestone ");
		if (milestoneMarker === -1) return;
		const index = Number(text.slice(milestoneMarker + 10).split(" ", 1)[0]);
		if (!Number.isFinite(index)) return;
		const personalHoursRequired = parseLabeledHours(text, "Personal") ?? 0;
		const communityHours = parseLabeledHours(text, "Community");
		const arpReward = parseLeadingCount(text, "ARP") ?? 0;
		const fragmentCount = parseLeadingCount(text, "Fragment");
		const milestone = {
			index,
			personalHoursRequired,
			arpReward,
			rewardLabel: cell.querySelector(":scope h3")?.textContent?.trim() || cell.querySelector(":scope img[alt]")?.getAttribute("alt") || (arpReward > 0 ? `${arpReward} ARP` : "Reward"),
			isCommunityUnlocked: /Community Unlocked/i.test(text) || isLabeledRowComplete(cell, "Community"),
			isAwarded: /\bAwarded\b/i.test(text) && !/\bNot\s+Awarded\b/i.test(text)
		};
		if (communityHours !== void 0) milestone.communityHoursRequired = communityHours;
		if (fragmentCount !== void 0 && arpReward <= 0) milestone.rewardLabel = `${fragmentCount} Fragments`;
		return milestone;
	}
	function parseCommunityEventPersonalHours(document_) {
		const hoursFromDom = document_.querySelector("#personal-hours")?.textContent?.trim();
		if (hoursFromDom && /\d/.test(hoursFromDom)) {
			const fromDom = Number(hoursFromDom);
			if (Number.isFinite(fromDom)) return fromDom;
		}
		const body = pageText(document_);
		const hoursFromText = /Your Total Hours:\s*([\d.]+)/i.exec(body)?.[1];
		if (hoursFromText) {
			const fromText = Number(hoursFromText);
			if (Number.isFinite(fromText)) return fromText;
		}
		const scriptSource = [...document_.querySelectorAll("script:not([src])")].map((script) => script.textContent ?? "").join("\n");
		const minutesMatch = /personalPlaytime\s*=\s*(\d+)/i.exec(scriptSource) ?? /personalPlaytime\s*=\s*(\d+)/i.exec(body);
		if (minutesMatch?.[1]) return Math.floor(Number(minutesMatch[1]) / 60);
		return 0;
	}
	function isAsciiWhitespace(char) {
		return " 	\n\r\f\v".includes(char);
	}
	function trailingNumberToken(value) {
		let end = value.length;
		while (end > 0 && isAsciiWhitespace(value[end - 1] ?? "")) end -= 1;
		let start = end;
		while (start > 0) {
			const char = value[start - 1] ?? "";
			if (char === "," || char >= "0" && char <= "9") {
				start -= 1;
				continue;
			}
			break;
		}
		if (start === end) return;
		return value.slice(start, end);
	}
	function leadingNumberToken(value) {
		let start = 0;
		while (start < value.length && isAsciiWhitespace(value[start] ?? "")) start += 1;
		let end = start;
		while (end < value.length) {
			const char = value[end] ?? "";
			if (char === "," || char >= "0" && char <= "9") {
				end += 1;
				continue;
			}
			break;
		}
		if (start === end) return;
		return value.slice(start, end);
	}
	function parseHoursOfCap(text) {
		const hourIndex = text.toLowerCase().indexOf("hour");
		if (hourIndex === -1) return;
		const beforeHour = text.slice(0, hourIndex);
		let leftRaw;
		let rightRaw;
		const ofIndex = beforeHour.toLowerCase().lastIndexOf(" of ");
		if (ofIndex === -1) {
			const slashIndex = beforeHour.lastIndexOf("/");
			if (slashIndex === -1) return;
			leftRaw = beforeHour.slice(0, slashIndex);
			rightRaw = beforeHour.slice(slashIndex + 1);
		} else {
			leftRaw = beforeHour.slice(0, ofIndex);
			rightRaw = beforeHour.slice(ofIndex + 4);
		}
		const leftToken = trailingNumberToken(leftRaw);
		const rightToken = leadingNumberToken(rightRaw);
		if (!leftToken || !rightToken) return;
		const hours = Number(leftToken.replaceAll(",", ""));
		const cap = Number(rightToken.replaceAll(",", ""));
		if (!Number.isFinite(hours) || !Number.isFinite(cap) || hours < 0 || cap <= 0) return;
		return {
			hours,
			cap
		};
	}
	function parseCommunityEventProgress(document_) {
		const candidates = [...document_.querySelectorAll("b, strong, .progress, .event-progress")].map((node) => node.textContent?.trim() ?? "");
		candidates.push(pageText(document_));
		for (const text of candidates) {
			const parsed = parseHoursOfCap(text);
			if (!parsed) continue;
			return {
				communityHours: parsed.hours,
				communityHoursCap: parsed.cap
			};
		}
		return {};
	}
	function parseCommunityEventTitleFromDocumentTitle(documentTitle) {
		const prefixMatch = /Steam Community Event\s*[-–]\s*/i.exec(documentTitle);
		if (!prefixMatch) return;
		let title = documentTitle.slice(prefixMatch.index + prefixMatch[0].length).trim();
		const pipeIndex = title.lastIndexOf("|");
		if (pipeIndex !== -1) {
			if (title.slice(pipeIndex + 1).trim().toLowerCase() === "alienware arena") title = title.slice(0, pipeIndex).trim();
		}
		return title.length > 0 ? title : void 0;
	}
	function parseCommunityEventTitle(document_) {
		const fromDocumentTitle = parseCommunityEventTitleFromDocumentTitle(document_.title?.replaceAll(/\s+/g, " ").trim() ?? "");
		if (fromDocumentTitle) return fromDocumentTitle;
		const fromEventLabel = document_.querySelector(".event-title-date, :scope .community-event-view .event-name")?.textContent?.replaceAll(/\s+/g, " ").trim();
		if (fromEventLabel && !isCommunityEventLiveDateBar(fromEventLabel)) return fromEventLabel;
	}
	function isCommunityEventLiveDateBar(text) {
		const normalized = text.replaceAll(/\s+/g, " ").trim();
		if (!/\bLIVE\b/i.test(normalized)) return false;
		return /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/i.test(normalized) || /\bLIVE\s*\|/i.test(normalized);
	}
	function readCommunityEventLiveBadge(document_) {
		if (document_.querySelector(".event-closed")) return false;
		if (document_.querySelector(".live-text")) return true;
		if (isCommunityEventLiveDateBar(document_.querySelector(".event-title-date, .live-container")?.textContent?.replaceAll(/\s+/g, " ").trim() ?? "")) return true;
	}
	function scrapeCommunityEventFromDocument(document_, url) {
		const personalHours = parseCommunityEventPersonalHours(document_);
		const isLive = readCommunityEventLiveBadge(document_) !== false;
		const milestones = [];
		let personalHoursFloor = Number.isFinite(personalHours) ? personalHours : 0;
		for (const cell of document_.querySelectorAll(".carousel-cell")) {
			const milestone = parseMilestoneCell(cell);
			if (!milestone) continue;
			milestones.push(milestone);
			if (isLabeledRowComplete(cell, "Personal") && milestone.personalHoursRequired > personalHoursFloor) personalHoursFloor = milestone.personalHoursRequired;
		}
		milestones.sort((left, right) => left.index - right.index);
		const awardedMilestones = applySequentialCommunityAwards(milestones);
		const safeHours = personalHoursFromMilestones(awardedMilestones, personalHoursFloor);
		const titleMatch = parseCommunityEventTitle(document_);
		const progress = parseCommunityEventProgress(document_);
		const playEligibility = scrapeSteamPlayEligibilityFromDocument(document_, { personalHours: safeHours });
		const steamAppId = scrapeSteamAppIdFromDocument(document_);
		const state = {
			scrapedAt: new Date().toISOString(),
			url,
			isLive,
			personalHours: safeHours,
			milestones: awardedMilestones,
			pendingArp: computePendingCommunityEventArp(safeHours, awardedMilestones, progress.communityHours),
			awardedArp: computeAwardedCommunityEventArp(awardedMilestones),
			playEligibility
		};
		if (steamAppId !== void 0) state.steamAppId = steamAppId;
		if (titleMatch) state.title = titleMatch;
		if (progress.communityHours !== void 0) state.communityHours = progress.communityHours;
		if (progress.communityHoursCap !== void 0) state.communityHoursCap = progress.communityHoursCap;
		return state;
	}
	var ASCE_CACHE_KEY = "asceCommunityHours";
	var ASCE_HOURS_URL = "https://raw.githubusercontent.com/MarvashMagalli/ASCE/main/stored_hours.json";
	var ASCE_CONFIG_URL = "https://raw.githubusercontent.com/MarvashMagalli/ASCE/main/configAWA.json";
	var ASCE_CACHE_TTL_MS = 15e5;
	var ASCE_ERROR_TTL_MS = 18e5;
	var ASCE_SAMPLE_MAX = 96;
	var FETCH_TIMEOUT_MS = 8e3;
	var inflightLookup = {};
	function hasPendingAsceRefresh() {
		return inflightLookup.promise !== void 0;
	}
	function isRecord$1(value) {
		return typeof value === "object" && value !== null;
	}
	function isAsceCache(value) {
		return isRecord$1(value) && typeof value.at === "string";
	}
	function gmGetJson(url) {
		return new Promise((resolve) => {
			_GM_xmlhttpRequest({
				method: "GET",
				url,
				anonymous: true,
				timeout: FETCH_TIMEOUT_MS,
				onload: (response) => {
					if (response.status < 200 || response.status >= 300) {
						resolve(void 0);
						return;
					}
					try {
						resolve(JSON.parse(response.responseText));
					} catch {
						resolve(void 0);
					}
				},
				onerror: () => {
					resolve(void 0);
				},
				ontimeout: () => {
					resolve(void 0);
				}
			});
		});
	}
	async function loadAsceCache() {
		const raw = await _GM.getValue(ASCE_CACHE_KEY, "");
		if (typeof raw !== "string" || raw.length === 0) return { at: "" };
		try {
			const parsed = JSON.parse(raw);
			if (!isAsceCache(parsed)) return { at: "" };
			return parsed;
		} catch {
			return { at: "" };
		}
	}
	async function saveAsceCache(cache) {
		await _GM.setValue(ASCE_CACHE_KEY, JSON.stringify(cache));
	}
	function cacheAgeMs(cache) {
		const at = Date.parse(cache.at);
		if (Number.isNaN(at)) return Number.POSITIVE_INFINITY;
		return Date.now() - at;
	}
	function isCacheFresh(cache) {
		if (!cache.at) return false;
		const ttl = cache.error ? ASCE_ERROR_TTL_MS : ASCE_CACHE_TTL_MS;
		return cacheAgeMs(cache) < ttl;
	}
	function communityEventSlug(url) {
		try {
			const parts = new URL(url, "https://na.alienwarearena.com").pathname.split("/").filter(Boolean);
			const index = parts.indexOf("community-event");
			if (index === -1) return;
			return parts[index + 1];
		} catch {
			return;
		}
	}
	function isAsceFeedForEvent(feed, eventUrl) {
		const slug = communityEventSlug(eventUrl);
		return slug !== void 0 && slug === feed.game;
	}
	function asceSlotMs(timestamp, hour) {
		const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(timestamp);
		if (!match || hour < 0 || hour > 23) return;
		const year = Number(match[1]);
		const month = Number(match[2]);
		const day = Number(match[3]);
		return Date.UTC(year, month - 1, day, hour, 0, 0);
	}
	function parseAsceHourPoint(value) {
		if (!isRecord$1(value)) return;
		const hours = value.value;
		const hour = value.hour;
		const timestamp = value.timestamp;
		if (typeof hours !== "number" || typeof hour !== "number" || typeof timestamp !== "string" || !Number.isFinite(hours) || hours < 0) return;
		const slotMs = asceSlotMs(timestamp, hour);
		if (slotMs === void 0) return;
		return {
			slotMs,
			hours
		};
	}
	function parseAsceHours(raw) {
		if (!Array.isArray(raw)) return [];
		const bySlot = new Map();
		for (const row of raw) {
			const parsed = parseAsceHourPoint(row);
			if (!parsed) continue;
			bySlot.set(parsed.slotMs, parsed.hours);
		}
		const samples = bySlot.keys().toArray().toSorted((left, right) => left - right).map((slotMs) => ({
			at: new Date(slotMs).toISOString(),
			hours: bySlot.get(slotMs) ?? 0
		}));
		if (samples.length > ASCE_SAMPLE_MAX) return samples.slice(-96);
		return samples;
	}
	function parseAsceArpReward(message) {
		const arpAt = message.toUpperCase().indexOf(" ARP");
		if (arpAt === -1) return 0;
		const token = message.slice(0, arpAt).trim().split(" ").at(-1);
		const reward = Number(token);
		return Number.isFinite(reward) && reward > 0 ? reward : 0;
	}
	function byHoursAscending(left, right) {
		return left.hours - right.hours;
	}
	function parseAsceGates(rows) {
		if (!Array.isArray(rows)) return [];
		const byHours = new Map();
		for (const row of rows) {
			if (!isRecord$1(row)) continue;
			const hours = row.current_hours;
			if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) continue;
			const label = typeof row.milestone_message === "string" && row.milestone_message.trim().length > 0 ? row.milestone_message.trim() : `${hours.toLocaleString()}h`;
			byHours.set(hours, {
				hours,
				arpReward: parseAsceArpReward(label),
				label,
				unlocked: row.unlocked === true
			});
		}
		return byHours.values().toArray().toSorted(byHoursAscending);
	}
	function parseAsceConfig(raw) {
		if (!isRecord$1(raw)) return {
			gates: [],
			unlockedHours: []
		};
		const game = typeof raw.game === "string" ? raw.game : void 0;
		const goalHours = typeof raw.goal_hours === "number" && Number.isFinite(raw.goal_hours) ? raw.goal_hours : void 0;
		const gates = [...parseAsceGates(raw.milestones), ...parseAsceGates(raw.stretch_goals)];
		const uniqueGates = new Map(gates.map((gate) => [gate.hours, gate])).values().toArray().toSorted(byHoursAscending);
		return {
			...game && { game },
			...goalHours !== void 0 && { goalHours },
			gates: uniqueGates,
			unlockedHours: uniqueGates.filter((gate) => gate.unlocked).map((gate) => gate.hours)
		};
	}
	function requiresAsceGateRefresh(feed) {
		return feed !== void 0 && feed.gates === void 0;
	}
	async function fetchAsceFeed() {
		const [hoursRaw, configRaw] = await Promise.all([gmGetJson(ASCE_HOURS_URL), gmGetJson(ASCE_CONFIG_URL)]);
		const config = parseAsceConfig(configRaw);
		const samples = parseAsceHours(hoursRaw);
		if (!config.game || samples.length === 0) return;
		return {
			game: config.game,
			samples,
			unlockedHours: config.unlockedHours,
			gates: config.gates,
			...config.goalHours !== void 0 && { goalHours: config.goalHours }
		};
	}
	async function loadAsceCommunityFeed(options = {}) {
		const cache = await loadAsceCache();
		if (!options.force && isCacheFresh(cache) && (cache.error || !requiresAsceGateRefresh(cache.feed))) {
			if (cache.error) return;
			return cache.feed;
		}
		if (inflightLookup.promise !== void 0) return inflightLookup.promise;
		const promise = (async () => {
			const feed = await fetchAsceFeed();
			const at = new Date().toISOString();
			if (!feed) {
				await saveAsceCache({
					at,
					error: true
				});
				return;
			}
			await saveAsceCache({
				at,
				feed
			});
			return feed;
		})();
		inflightLookup.promise = promise;
		try {
			return await promise;
		} finally {
			delete inflightLookup.promise;
		}
	}
	function applyAsceUnlocks(milestones, unlockedHours) {
		if (unlockedHours.length === 0) return milestones;
		const unlocked = new Set(unlockedHours);
		return milestones.map((milestone) => {
			if (milestone.isCommunityUnlocked) return milestone;
			const requiredHours = milestone.communityHoursRequired;
			if (requiredHours === void 0 || !unlocked.has(requiredHours)) return milestone;
			return {
				...milestone,
				isCommunityUnlocked: true
			};
		});
	}
	function resolveCommunityHours(scraped, asceHours) {
		if (scraped === void 0) return asceHours;
		if (asceHours === void 0) return scraped;
		return Math.max(scraped, asceHours);
	}
	function withLiveHoursSample(samples, event) {
		if (event.communityHours === void 0) return samples;
		const last = samples.at(-1);
		if (!last || event.communityHours <= last.hours) return samples;
		return [...samples, {
			at: event.scrapedAt,
			hours: event.communityHours
		}];
	}
	function applyAsceFeedToEvent(event, feed) {
		if (!event.isLive || !isAsceFeedForEvent(feed, event.url)) return;
		const samples = withLiveHoursSample(feed.samples, event);
		if (samples.length === 0) return;
		const lastAsceHours = feed.samples.at(-1)?.hours;
		const communityHours = resolveCommunityHours(event.communityHours, lastAsceHours);
		const milestones = applySequentialCommunityAwards(applyCommunityHoursUnlocks(upsertCommunityEventMilestoneGates(applyAsceUnlocks(event.milestones, feed.unlockedHours), feed.gates ?? []), communityHours));
		const next = {
			...event,
			milestones,
			pendingArp: computePendingCommunityEventArp(event.personalHours, milestones, communityHours),
			communityHoursSamples: samples,
			communityHoursSource: "asce"
		};
		if (communityHours !== void 0) next.communityHours = communityHours;
		if (next.communityHoursCap === void 0 && feed.goalHours !== void 0) next.communityHoursCap = feed.goalHours;
		return next;
	}
	function asceEventSignature(event) {
		const last = event.communityHoursSamples?.at(-1);
		const waitingHours = event.milestones.filter((milestone) => !milestone.isAwarded && milestone.arpReward > 0).map((milestone) => milestone.communityHoursRequired ?? 0).join(",");
		return [
			event.communityHours ?? "",
			event.pendingArp,
			event.milestones.length,
			waitingHours,
			event.communityHoursSamples?.length ?? 0,
			last?.hours ?? "",
			last?.at ?? ""
		].join("|");
	}
	function applyFeedIfLive(state, feed) {
		const event = state.communityEvent;
		if (!event?.isLive) return;
		const next = applyAsceFeedToEvent(event, feed);
		if (!next) return;
		state.communityEvent = state.arpLog ? reconcileCommunityEventWithArpLog(next, state.arpLog) : next;
	}
	async function applyAsceCommunityHours(state) {
		if (!state.communityEvent?.isLive) return;
		const cache = await loadAsceCache();
		if (cache.feed && !cache.error) applyFeedIfLive(state, cache.feed);
		if (!isCacheFresh(cache)) {
			loadAsceCommunityFeed();
			return;
		}
		if (cache.error || !requiresAsceGateRefresh(cache.feed)) return;
		const feed = await loadAsceCommunityFeed({ force: true });
		if (feed) applyFeedIfLive(state, feed);
	}
	async function didRefreshAsceCommunityHours(state, options = {}) {
		const event = state.communityEvent;
		if (!event?.isLive) return false;
		const before = asceEventSignature(event);
		const feed = await loadAsceCommunityFeed({ force: options.force === true });
		if (!feed) return false;
		applyFeedIfLive(state, feed);
		const next = state.communityEvent;
		if (!next) return false;
		return asceEventSignature(next) !== before;
	}
	function pageWindow() {
		try {
			return _unsafeWindow;
		} catch {}
		return globalThis;
	}
	function asFiniteNumber(value) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim() !== "") {
			const parsed = Number(value.replaceAll(",", ""));
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	function readPageNumber(name) {
		try {
			return asFiniteNumber(pageWindow()[name]);
		} catch {
			return;
		}
	}
	function parseInlineNumber(document_, names) {
		const pattern = new RegExp(String.raw`(?:var\s+|window\.)?(?:${names.join("|")})\s*=\s*(\d+)`);
		for (const script of document_.querySelectorAll("script")) {
			const match = pattern.exec(script.textContent ?? "");
			if (match?.[1]) return Number(match[1]);
		}
	}
	function readPageArpTier(document_ = document) {
		if (document_ === document) {
			const tier = readPageNumber("arp_tier");
			if (tier !== void 0 && tier >= 0) return tier;
		}
		const fromScript = parseInlineNumber(document_, ["arp_tier"]);
		if (fromScript !== void 0) return fromScript;
		const tierImg = document_.querySelector("img[src*=\"/images/content/tier-tags/\"]");
		const tierMatch = /tier-tags\/(\d+)\.png/.exec(tierImg?.src ?? "");
		if (!tierMatch?.[1]) return;
		const tier = Number(tierMatch[1]);
		return Number.isFinite(tier) ? tier : void 0;
	}
	function readPageFragmentBalance(document_ = document) {
		if (document_ === document) {
			const fragments = readPageNumber("fragment_balance");
			if (fragments !== void 0 && fragments >= 0) return fragments;
		}
		const fromScript = parseInlineNumber(document_, ["fragment_balance"]);
		return fromScript !== void 0 && fromScript >= 0 ? fromScript : void 0;
	}
	function readPageRedeemableArp(document_ = document) {
		const names = [
			"arp_balance",
			"user_arp",
			"arp_points",
			"redeemable_arp"
		];
		if (document_ === document) for (const name of names) {
			const value = readPageNumber(name);
			if (value !== void 0 && value >= 0) return value;
		}
		const fromScript = parseInlineNumber(document_, names);
		return fromScript !== void 0 && fromScript >= 0 ? fromScript : void 0;
	}
	function giveawayKeyFromUnknown(value) {
		if (typeof value !== "object" || !value) return;
		const row = value;
		const id = row.giveaway_id ?? row.giveawayId ?? row.id;
		if (id === void 0 || id === null) return;
		const status = typeof row.status === "string" ? row.status : "";
		const entry = {
			giveawayId: String(id),
			status
		};
		const remaining = asFiniteNumber(row.remaining);
		if (remaining !== void 0) entry.remaining = remaining;
		return entry;
	}
	function readPageGiveawayKeys() {
		let raw;
		try {
			raw = pageWindow().giveawayKeys;
		} catch {
			return [];
		}
		if (!Array.isArray(raw)) return [];
		const keys = [];
		for (const item of raw) {
			const entry = giveawayKeyFromUnknown(item);
			if (entry) keys.push(entry);
		}
		return keys;
	}
	function giveawayKeyStatus(giveawayId) {
		return readPageGiveawayKeys().find((entry) => entry.giveawayId === giveawayId);
	}
	var SETTINGS_KEY = "artifactOptimizerSettings";
	var HOURS_PER_DAY = 24;
	var MS_PER_HOUR$1 = 36e5;
	var COOLDOWN_MS = HOURS_PER_DAY * MS_PER_HOUR$1;
	var NOTIFICATION_TYPE_KEYS = [
		"swap",
		"community",
		"vault",
		"giveaways"
	];
	var NOTIFICATION_TYPE_COPY = {
		swap: {
			title: "Recommended swap",
			hint: "When a better loadout is waiting on a 24h lock — not every unlock."
		},
		community: {
			title: "Community Event",
			hint: "When community hours unlock pending ARP."
		},
		vault: {
			title: "Game Vault",
			hint: "When the vault opens or new games appear."
		},
		giveaways: {
			title: "New giveaways",
			hint: "Official Alienware key giveaways — not community giveaways."
		}
	};
	var DEFAULT_NOTIFICATION_TYPES = {
		swap: true,
		community: true,
		vault: true,
		giveaways: true
	};
	var DEFAULT_ACTIVITIES = {
		timeOnSite: {
			enabled: true,
			frequency: 1
		},
		steamQuests: {
			enabled: true,
			frequency: 1
		},
		watchTwitch: {
			enabled: true,
			frequency: 1
		},
		dailyCalendar: {
			enabled: true,
			frequency: 1
		},
		discordPoll: {
			enabled: true,
			frequency: 1
		},
		dailyQuests: {
			enabled: true,
			frequency: 1
		},
		steamCommunityEvent: {
			enabled: true,
			frequency: 1
		}
	};
	var defaultArtifactSettings = {
		activities: { ...DEFAULT_ACTIVITIES },
		pendingVaultPurchaseArp: 0,
		manualArtifacts: [],
		preferScraped: true,
		slotCooldowns: [],
		preferredTwitchStreamers: [],
		utcDailyEndBufferHours: 1,
		browserNotifications: false,
		notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES },
		allowAccountActions: false
	};
	function isPartialSettings(value) {
		return typeof value === "object" && !!value;
	}
	function mergeActivities(base, incoming) {
		if (!incoming) return base;
		const legacy = incoming;
		const next = { ...base };
		if (legacy.communityEvent && !legacy.dailyQuests) next.dailyQuests = {
			enabled: legacy.communityEvent.enabled,
			frequency: typeof legacy.communityEvent.frequency === "number" ? legacy.communityEvent.frequency : 1
		};
		for (const key of Object.keys(DEFAULT_ACTIVITIES)) {
			const value = incoming[key];
			if (!value) continue;
			next[key] = {
				enabled: value.enabled,
				frequency: typeof value.frequency === "number" ? value.frequency : 1
			};
		}
		return next;
	}
	function applyParsedSettings(settings, parsed) {
		settings.activities = mergeActivities(settings.activities, parsed.activities);
		if (typeof parsed.pendingVaultPurchaseArp === "number") settings.pendingVaultPurchaseArp = parsed.pendingVaultPurchaseArp;
		if (typeof parsed.manualFragments === "number") settings.manualFragments = parsed.manualFragments;
		if (Array.isArray(parsed.manualArtifacts)) settings.manualArtifacts = parsed.manualArtifacts;
		if (typeof parsed.preferScraped === "boolean") settings.preferScraped = parsed.preferScraped;
		if (Array.isArray(parsed.slotCooldowns)) settings.slotCooldowns = parsed.slotCooldowns;
		if (typeof parsed.vaultDiscountDismissedCycle === "string") {
			if (parsed.vaultDiscountDismissedCycle) settings.vaultDiscountDismissedCycle = parsed.vaultDiscountDismissedCycle;
			else delete settings.vaultDiscountDismissedCycle;
		}
		if (Array.isArray(parsed.preferredTwitchStreamers)) settings.preferredTwitchStreamers = parsePreferredTwitchStreamers(parsed.preferredTwitchStreamers.filter((item) => typeof item === "string").join("\n"));
		if (typeof parsed.utcDailyEndBufferHours === "number") settings.utcDailyEndBufferHours = clampUtcDailyEndBufferHours(parsed.utcDailyEndBufferHours);
		if (typeof parsed.browserNotifications === "boolean") settings.browserNotifications = parsed.browserNotifications;
		if (typeof parsed.allowAccountActions === "boolean") settings.allowAccountActions = parsed.allowAccountActions;
		settings.notificationTypes = mergeNotificationTypes(settings.notificationTypes, parsed.notificationTypes);
	}
	function mergeNotificationTypes(base, incoming) {
		if (!incoming) return base;
		const next = { ...base };
		for (const key of NOTIFICATION_TYPE_KEYS) if (typeof incoming[key] === "boolean") next[key] = incoming[key];
		return next;
	}
	function twitchLoginFromInput(value) {
		let text = value.trim();
		if (!text) return "";
		text = text.replace(/^https?:\/\//i, "");
		text = text.replace(/^(www\.)?twitch\.tv\//i, "");
		text = text.replace(/^@/, "");
		return (text.split(/[/?#]/, 1)[0] ?? "").trim().toLowerCase();
	}
	function parsePreferredTwitchStreamers(raw) {
		const logins = [];
		const seen = new Set();
		for (const token of raw.split(/[\n,]+/)) {
			const login = twitchLoginFromInput(token);
			if (!login || seen.has(login)) continue;
			seen.add(login);
			logins.push(login);
		}
		return logins;
	}
	function clampUtcDailyEndBufferHours(hours) {
		if (!Number.isFinite(hours)) return 1;
		return Math.min(12, Math.max(0, hours));
	}
	function utcDailyEndBufferMs(settings) {
		return clampUtcDailyEndBufferHours(settings.utcDailyEndBufferHours) * MS_PER_HOUR$1;
	}
	async function getArtifactSettings() {
		const raw = await _GM.getValue(SETTINGS_KEY);
		const settings = {
			...defaultArtifactSettings,
			activities: { ...DEFAULT_ACTIVITIES },
			manualArtifacts: [],
			slotCooldowns: [],
			preferredTwitchStreamers: [],
			notificationTypes: { ...DEFAULT_NOTIFICATION_TYPES }
		};
		if (!raw) return settings;
		try {
			const parsedUnknown = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!isPartialSettings(parsedUnknown)) return settings;
			applyParsedSettings(settings, parsedUnknown);
		} catch (error) {
			console.error("[Artifact Optimizer] Error parsing settings:", error);
		}
		return settings;
	}
	async function saveArtifactSettings(patch) {
		const previous = await getArtifactSettings();
		const next = {
			...previous,
			...patch,
			activities: patch.activities ? {
				...previous.activities,
				...patch.activities
			} : previous.activities,
			notificationTypes: patch.notificationTypes ? {
				...previous.notificationTypes,
				...patch.notificationTypes
			} : previous.notificationTypes,
			utcDailyEndBufferHours: clampUtcDailyEndBufferHours(patch.utcDailyEndBufferHours ?? previous.utcDailyEndBufferHours)
		};
		await _GM.setValue(SETTINGS_KEY, JSON.stringify(next));
		return next;
	}
	function findCooldownEntry(settings, position) {
		return settings.slotCooldowns.find((entry) => entry.position === position);
	}
	function isShowroomSlotLocked(position, options = {}) {
		if (options.equippedSlotLocked === true) return true;
		if (options.equippedSlotLocked === false) return false;
		return options.slotLocks?.[position] === true;
	}
	function showroomCooldownRemainingMs(settings, position, options = {}) {
		if (!isShowroomSlotLocked(position, options)) return 0;
		return cooldownRemainingMs(settings, position, options.now);
	}
	function cooldownRemainingMs(settings, position, now = Date.now()) {
		const entry = findCooldownEntry(settings, position);
		if (!entry) return 0;
		const changedAt = Date.parse(entry.changedAt);
		if (Number.isNaN(changedAt)) return 0;
		return Math.max(0, COOLDOWN_MS - (now - changedAt));
	}
	async function recordSlotChange(position, artifactInstanceId) {
		const rest = (await getArtifactSettings()).slotCooldowns.filter((entry) => entry.position !== position);
		const entry = {
			position,
			changedAt: new Date().toISOString()
		};
		if (artifactInstanceId !== void 0) entry.artifactInstanceId = artifactInstanceId;
		rest.push(entry);
		await saveArtifactSettings({ slotCooldowns: rest });
	}
	var SLOT_POSITIONS = [
		1,
		2,
		3
	];
	function isCompleteSlotLockMap(slotLocks) {
		return SLOT_POSITIONS.every((position) => typeof slotLocks[position] === "boolean");
	}
	async function syncSlotLocksFromScrape(slotLocks, now = Date.now()) {
		const previous = (await getArtifactSettings()).slotCooldowns;
		const next = [];
		for (const position of SLOT_POSITIONS) {
			if (slotLocks[position] !== true) continue;
			const existing = previous.find((entry) => entry.position === position);
			if (existing) {
				next.push(existing);
				continue;
			}
			next.push({
				position,
				changedAt: new Date(now).toISOString(),
				estimated: true
			});
		}
		if (!isCompleteSlotLockMap(slotLocks)) {
			for (const entry of previous) if (slotLocks[entry.position] !== false && next.every((row) => row.position === entry.position)) next.push(entry);
		}
		if (JSON.stringify(previous) !== JSON.stringify(next)) await saveArtifactSettings({ slotCooldowns: next });
	}
	function isNotificationTypeEnabled(settings, key) {
		return settings.notificationTypes[key] ?? true;
	}
	function areAccountActionsEnabled(settings) {
		return settings.allowAccountActions;
	}
	var SNAPSHOT_KEY = "artifactSnapshot";
	function isArtifactSnapshot(value) {
		if (typeof value !== "object" || !value) return false;
		const v = value;
		return Array.isArray(v.artifacts) && typeof v.fragments === "number";
	}
	async function loadSnapshot() {
		const raw = await _GM.getValue(SNAPSHOT_KEY);
		if (!raw) return;
		try {
			const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
			return isArtifactSnapshot(parsed) ? parsed : void 0;
		} catch {
			return;
		}
	}
	async function saveSnapshot(snapshot) {
		await _GM.setValue(SNAPSHOT_KEY, JSON.stringify(snapshot));
	}
	async function applySnapshotUpgrade(instanceId) {
		const snapshot = await loadSnapshot();
		if (!snapshot) return;
		const current = snapshot.artifacts.find((artifact) => artifact.instanceId === instanceId);
		if (!current || current.tier >= ArtifactTier.Interstellar) return snapshot;
		const toTier = current.tier + 1;
		const family = getArtifactById(current.familyId);
		const cost = current.upgradeCost ?? fragmentCostToUpgradeFrom(current.tier) ?? 0;
		const upgraded = {
			...current,
			tier: toTier,
			displayName: family ? displayNameFor(family, toTier) : current.displayName,
			maxLevel: toTier === ArtifactTier.Interstellar
		};
		const nextCost = fragmentCostToUpgradeFrom(toTier);
		if (nextCost === void 0) delete upgraded.upgradeCost;
		else upgraded.upgradeCost = nextCost;
		const next = {
			...snapshot,
			scrapedAt: new Date().toISOString(),
			fragments: Math.max(0, snapshot.fragments - cost),
			artifacts: snapshot.artifacts.map((artifact) => artifact.instanceId === instanceId ? upgraded : artifact)
		};
		await saveSnapshot(next);
		return next;
	}
	function readFragmentBalance(document_) {
		const fromPage = readPageFragmentBalance(document_);
		if (fromPage !== void 0) return fromPage;
		const text = document_.body?.textContent ?? "";
		const match = /Fragments:\s*([\d,]+)/i.exec(text);
		if (match?.[1]) return Number(match[1].replaceAll(",", ""));
		return 0;
	}
	function readUsernameFrom(document_, pathHint) {
		const pathMatch = /\/member\/([^/]+)\/artifacts/.exec(pathHint ?? location.pathname);
		if (pathMatch?.[1]) return pathMatch[1];
		const link = document_.querySelector("a[href*=\"/member/\"][href$=\"/artifacts\"]");
		return (link ? /\/member\/([^/]+)\/artifacts/.exec(link.getAttribute("href") ?? "") : void 0)?.[1];
	}
	function readUsername() {
		return readUsernameFrom(document);
	}
	var USER_ARTIFACTS_ROOM_PATH = "/user-artifacts-room";
	function resolveShowroomUrl(username) {
		const name = username ?? readUsername();
		if (name) return `/member/${encodeURIComponent(name)}/artifacts`;
		const link = document.querySelector("a[href*=\"/member/\"][href$=\"/artifacts\"]");
		if (link?.pathname) return link.pathname;
		return USER_ARTIFACTS_ROOM_PATH;
	}
	function parseEquippedPosition(card) {
		const unequip = card.parentElement?.querySelector("button[onclick*=\"unequipArtifact\"]");
		if (!unequip) return;
		const match = /unequipArtifact\s*\(\s*\d+\s*,\s*([123])\s*\)/.exec(unequip.getAttribute("onclick") ?? "");
		if (!match?.[1]) return;
		return Number(match[1]);
	}
	function normalizeName(value) {
		return value.replaceAll(/\s+/g, " ").trim().toLowerCase();
	}
	function isShowcaseSlotLocked(slot) {
		if (slot.querySelector(":scope i.fa-lock-open, :scope i.fa-unlock")) return false;
		return Boolean(slot.querySelector(":scope i.fa-lock"));
	}
	function scrapeShowcaseSlots(document_) {
		const root = document_.querySelector(".slots");
		const slots = root ? [...root.querySelectorAll(":scope > .slot")] : [...document_.querySelectorAll(".slot")];
		const result = [];
		let position = 1;
		for (const slot of slots) {
			if (position > 3) break;
			const displayName = ((slot.querySelector(":scope .slot-front img") ?? slot.querySelector(":scope img"))?.alt ?? "").trim();
			if (!displayName || /^artifact$/i.test(displayName)) {
				position = position + 1;
				continue;
			}
			result.push({
				position,
				displayName,
				isLocked: isShowcaseSlotLocked(slot)
			});
			position = position + 1;
		}
		return result;
	}
	function applyShowcaseEquips(artifacts, showcase) {
		const slotLocks = {
			1: false,
			2: false,
			3: false
		};
		for (const slot of showcase) {
			slotLocks[slot.position] = slot.isLocked;
			const match = artifacts.find((artifact) => normalizeName(artifact.displayName) === normalizeName(slot.displayName));
			if (!match) continue;
			match.equippedPosition = slot.position;
			match.slotLocked = slot.isLocked;
		}
		return slotLocks;
	}
	function parseFooterTier(card) {
		const tip = card.querySelector("img[data-original-title]")?.dataset.originalTitle ?? "";
		const tierLabel = /(Weapon|Clothing|Power|Language|Precious Gems|Tech|Knowledge|Social|Architecture)\s*-\s*(Rust|Bronze|Silver|Gold|Platinum|Interstellar)/i.exec(tip)?.[2]?.toLowerCase();
		if (!tierLabel) return;
		return {
			rust: ArtifactTier.Rust,
			bronze: ArtifactTier.Bronze,
			silver: ArtifactTier.Silver,
			gold: ArtifactTier.Gold,
			platinum: ArtifactTier.Platinum,
			interstellar: ArtifactTier.Interstellar
		}[tierLabel];
	}
	function scrapeShowroomFromDocument(document_, pathHint) {
		const cards = document_.querySelectorAll("a.artifact-list-item.change-artifact-modal");
		const artifacts = [];
		for (const card of cards) {
			const instanceId = Number(card.dataset.id);
			if (Number.isNaN(instanceId)) continue;
			const displayName = (card.dataset.title ?? "").trim();
			if (!displayName) continue;
			const resolved = resolveArtifactByDisplayName(displayName);
			const footerTier = parseFooterTier(card);
			const tier = resolved?.tier ?? footerTier;
			if (tier === void 0 || !resolved) {
				console.warn("[Artifact Optimizer] Unrecognized artifact:", displayName);
				continue;
			}
			const upgradeCostRaw = card.dataset.upgradeCost;
			const parsedUpgradeCost = upgradeCostRaw === void 0 || upgradeCostRaw === "" ? void 0 : Number(upgradeCostRaw);
			const upgradeCost = Number.isNaN(parsedUpgradeCost) ? void 0 : parsedUpgradeCost;
			const isMaxLevel = card.dataset.maxLevel === "true" || card.dataset.maxLevel === "1" || upgradeCost === 0;
			const owned = {
				instanceId,
				familyId: resolved.definition.id,
				displayName,
				tier,
				category: resolved.definition.category,
				maxLevel: isMaxLevel,
				perkDescription: card.dataset.descriptionPerk ?? ""
			};
			if (upgradeCost !== void 0) owned.upgradeCost = upgradeCost;
			const equippedPosition = parseEquippedPosition(card);
			if (equippedPosition !== void 0) owned.equippedPosition = equippedPosition;
			artifacts.push(owned);
		}
		const slotLocks = applyShowcaseEquips(artifacts, scrapeShowcaseSlots(document_));
		return {
			scrapedAt: new Date().toISOString(),
			username: readUsernameFrom(document_, pathHint),
			fragments: readFragmentBalance(document_),
			artifacts,
			slotLocks
		};
	}
	function scrapeShowroom() {
		return scrapeShowroomFromDocument(document, location.pathname);
	}
	function isShowroomDocumentReady(document_) {
		return Boolean(document_.querySelector("a.artifact-list-item.change-artifact-modal, #weapon-section"));
	}
	async function waitForShowroomDocument(timeoutMs = 12e3) {
		if (isShowroomDocumentReady(document)) return;
		await new Promise((resolve) => {
			let isSettled = false;
			const observer = new MutationObserver(() => {
				if (isShowroomDocumentReady(document)) finish();
			});
			const timer = setTimeout(finish, timeoutMs);
			function finish() {
				if (isSettled) return;
				isSettled = true;
				observer.disconnect();
				clearTimeout(timer);
				resolve();
			}
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true
			});
		});
	}
	async function scrapeAndPersist() {
		if (!isShowroomDocumentReady(document)) await waitForShowroomDocument();
		if (!isShowroomDocumentReady(document)) {
			const existing = await loadSnapshot();
			if (existing) return existing;
		}
		const snapshot = scrapeShowroom();
		if (snapshot.artifacts.length === 0) {
			const existing = await loadSnapshot();
			if (existing && existing.artifacts.length > 0) return existing;
		}
		await saveSnapshot(snapshot);
		await syncSlotLocksFromScrape(snapshot.slotLocks ?? {});
		return snapshot;
	}
	function isArtifactsShowroomPage() {
		return /\/member\/[^/]+\/artifacts\/?$/.test(location.pathname) || /\/user-artifacts-room\/?$/.test(location.pathname);
	}
	var ARP_LOG_ROW_SELECTOR = ".card-table-row";
	var ARP_LOG_AFTER_ROWS_SELECTOR = "#arp-logs-per-page, #arp-log-chart";
	var ARP_LOG_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
	var ARP_LOG_AMOUNT_RE = /^[+]?\d[\d,]*$/;
	var ARP_LOG_TOGGLE_RE = /^[▼▲^▾▴]$/;
	function parseRedeemableArpText(text) {
		const match = /Redeemable ARP:\s*([\d,]+)/i.exec(text);
		if (!match?.[1]) return;
		const value = Number(match[1].replaceAll(",", ""));
		return Number.isFinite(value) ? value : void 0;
	}
	function scrapeRedeemableArpFromDocument(document_) {
		const fromPage = readPageRedeemableArp(document_);
		if (fromPage !== void 0) return fromPage;
		return parseRedeemableArpText(pageText(document_));
	}
	function applyRedeemableArpFromDocument(next, document_) {
		const arp = scrapeRedeemableArpFromDocument(document_);
		if (arp === void 0) return;
		next.arpLog = {
			scrapedAt: next.arpLog?.scrapedAt ?? new Date().toISOString(),
			recent: next.arpLog?.recent ?? [],
			...next.arpLog,
			redeemableArp: arp
		};
	}
	function parseArpAmount(text) {
		const value = Number(text.replaceAll(",", "").replace(/^\+/, ""));
		return Number.isFinite(value) ? value : void 0;
	}
	function scrapeArpLogRowsFromTable(document_) {
		const entries = [];
		for (const row of document_.querySelectorAll(ARP_LOG_ROW_SELECTOR)) {
			const cols = [...row.children].map((element) => (element.textContent ?? "").replaceAll(/\s+/g, " ").trim());
			const date = cols.find((col) => ARP_LOG_DATE_RE.test(col));
			const arpText = cols.findLast((col) => col !== date && ARP_LOG_AMOUNT_RE.test(col));
			const action = cols.find((col) => col.length > 0 && col !== date && col !== arpText && !ARP_LOG_TOGGLE_RE.test(col));
			if (!action || arpText === void 0) continue;
			const arp = parseArpAmount(arpText);
			if (arp === void 0) continue;
			const entry = {
				action,
				arp
			};
			if (date) entry.date = date;
			entries.push(entry);
		}
		return entries;
	}
	function scrapeArpLogRowsFromText(body) {
		const actionNames = [
			"Time On Site",
			"Game Prize",
			"Daily Login Calendar",
			"Daily Login Streak",
			"Discord Poll",
			"Steam Community Event Reward",
			"Steam Quest",
			"Steam Quests",
			"Twitch Passive",
			"Watch Twitch",
			"Community Event",
			"Forum Post",
			"Giveaway",
			"Battle Pass Reward",
			"Battle Pass",
			"Quest"
		].join("|");
		const rowPattern = new RegExp(String.raw`(${actionNames})\s+(\d+)\s+(\d{4}-\d{2}-\d{2})`, "gi");
		const entries = [];
		for (const match of body.matchAll(rowPattern)) {
			const entry = {
				action: match[1] ?? "Unknown",
				arp: Number(match[2])
			};
			if (match[3]) entry.date = match[3];
			entries.push(entry);
		}
		return entries;
	}
	function isArpLogDocumentReady(document_) {
		if (!document_.body) return false;
		return Boolean(document_.querySelector(`${ARP_LOG_ROW_SELECTOR}, ${ARP_LOG_AFTER_ROWS_SELECTOR}`));
	}
	function arpLogSignature(document_) {
		if (!isArpLogDocumentReady(document_)) return "";
		return scrapeArpLogFromDocument(document_).recent.map((entry) => `${entry.date ?? ""}|${entry.action}|${entry.arp}`).join(";");
	}
	async function waitForArpLogDocument(timeoutMs = 12e3) {
		if (isArpLogDocumentReady(document)) return;
		await new Promise((resolve) => {
			let isSettled = false;
			const observer = new MutationObserver(() => {
				if (isArpLogDocumentReady(document)) finish();
			});
			const timer = setTimeout(finish, timeoutMs);
			function finish() {
				if (isSettled) return;
				isSettled = true;
				observer.disconnect();
				clearTimeout(timer);
				resolve();
			}
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true
			});
		});
	}
	function scrapeArpLogFromDocument(document_) {
		const body = pageText(document_);
		const state = {
			scrapedAt: new Date().toISOString(),
			recent: []
		};
		const redeemableArp = parseRedeemableArpText(body);
		if (redeemableArp !== void 0) state.redeemableArp = redeemableArp;
		const lifetime = /Lifetime ARP:\s*([\d,]+)/i.exec(body);
		if (lifetime?.[1]) state.lifetimeArp = Number(lifetime[1].replaceAll(",", ""));
		const todayTotal = /Total ARP earned today:\s*([\d,]+)/i.exec(body);
		if (todayTotal?.[1]) state.todayDelta = Number(todayTotal[1].replaceAll(",", ""));
		else {
			const plusMatch = /Redeemable ARP:[\s\S]{0,80}?\+\s*([\d,]+)/i.exec(body);
			if (plusMatch?.[1]) state.todayDelta = Number(plusMatch[1].replaceAll(",", ""));
		}
		const fromTable = scrapeArpLogRowsFromTable(document_);
		state.recent = fromTable.length > 0 ? fromTable : scrapeArpLogRowsFromText(body);
		return state;
	}
	var ARP_LOG_UNSEEN_SCRAPED_AT = new Date(0).toISOString();
	function mergeArpLogScrapedAt(scraped, previous) {
		if (scraped.recent.length > 0) return scraped.scrapedAt;
		if (previous.recent.length > 0) return previous.scrapedAt;
		return ARP_LOG_UNSEEN_SCRAPED_AT;
	}
	function mergeArpLogScrape(scraped, previous) {
		if (!previous) {
			if (scraped.recent.length === 0) return {
				...scraped,
				scrapedAt: ARP_LOG_UNSEEN_SCRAPED_AT
			};
			return scraped;
		}
		const seen = new Set();
		const recent = [];
		for (const entry of [...scraped.recent, ...previous.recent]) {
			const key = `${entry.date ?? ""}|${entry.action}|${entry.arp}`;
			if (seen.has(key)) continue;
			seen.add(key);
			recent.push(entry);
		}
		recent.sort((left, right) => (right.date ?? "").localeCompare(left.date ?? ""));
		const redeemableArp = scraped.redeemableArp ?? previous.redeemableArp;
		const lifetimeArp = scraped.lifetimeArp ?? previous.lifetimeArp;
		const todayDelta = scraped.todayDelta ?? previous.todayDelta;
		return {
			scrapedAt: mergeArpLogScrapedAt(scraped, previous),
			...redeemableArp !== void 0 && { redeemableArp },
			...lifetimeArp !== void 0 && { lifetimeArp },
			...todayDelta !== void 0 && { todayDelta },
			recent
		};
	}
	function serializePostBody(body, encoding) {
		if (encoding === "json") return JSON.stringify(body);
		const parameters = new URLSearchParams();
		for (const [key, value] of Object.entries(body)) {
			if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
			parameters.set(key, String(value));
		}
		return parameters.toString();
	}
	function resultFromResponse(status, parsed) {
		if (status < 200 || status >= 300) {
			const result = {
				ok: false,
				status,
				error: parsed?.message ?? `Request failed (${status})`
			};
			if (parsed?.message) result.message = parsed.message;
			return result;
		}
		if (parsed?.success === false) {
			const result = {
				ok: false,
				status,
				error: parsed.message ?? "Request rejected (slot may be on 24h cooldown or already set)."
			};
			if (parsed.message) result.message = parsed.message;
			return result;
		}
		const result = {
			ok: true,
			status
		};
		if (parsed?.message) result.message = parsed.message;
		return result;
	}
	async function postRequest(path, body, encoding) {
		try {
			const response = await fetch(path, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
					Accept: "application/json, text/javascript, */*; q=0.01",
					"X-Requested-With": "XMLHttpRequest"
				},
				body: serializePostBody(body, encoding)
			});
			const text = await response.text();
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = void 0;
			}
			return resultFromResponse(response.status, parsed);
		} catch (error) {
			return {
				ok: false,
				status: 0,
				error: error instanceof Error ? error.message : "Network error"
			};
		}
	}
	async function postJson(path, body) {
		return postRequest(path, body, "json");
	}
	async function postForm(path, body) {
		return postRequest(path, body, "form");
	}
	async function equipArtifact(artifactId, position) {
		const result = await postJson("/change-user-artifacts", {
			artifactId,
			position
		});
		if (result.ok) await recordSlotChange(position, artifactId);
		return result;
	}
	async function upgradeArtifact(artifactId) {
		return postJson("/upgrade-user-artifact", { artifactId });
	}
	async function claimBattlePassReward(path, body = {}) {
		return postForm(path, body);
	}
	function pickStuckLockNudgeTarget(artifacts) {
		const maxed = artifacts.filter((artifact) => artifact.maxLevel || artifact.upgradeCost === 0);
		if (maxed.length === 0) return;
		const target = maxed.find((artifact) => /warrior script/i.test(artifact.displayName)) ?? maxed[0];
		if (!target) return;
		return {
			instanceId: target.instanceId,
			displayName: target.displayName
		};
	}
	async function nudgeStuckSlotLocks(artifacts) {
		const target = pickStuckLockNudgeTarget(artifacts);
		if (!target) {
			console.info("[Artifact Optimizer] Stuck-lock nudge skipped — no maxed 0-frag artifact");
			return;
		}
		const result = await upgradeArtifact(target.instanceId);
		console.info("[Artifact Optimizer] Stuck-lock nudge", {
			name: target.displayName,
			id: target.instanceId,
			ok: result.ok,
			message: result.message ?? result.error
		});
		return result;
	}
	async function applyLoadout(targets, currentlyEquipped) {
		const results = [];
		const applied = [];
		for (const target of targets) {
			if (currentlyEquipped.some((c) => c.artifactId === target.artifactId && c.position === target.position)) continue;
			const equipResult = await equipArtifact(target.artifactId, target.position);
			results.push(equipResult);
			if (!equipResult.ok) return {
				results,
				allOk: false,
				applied
			};
			applied.push(target);
		}
		return {
			results,
			allOk: results.every((result) => result.ok),
			applied
		};
	}
	function scrapeBattlePassFromDocument(document_) {
		const body = pageText(document_);
		const popups = document_.querySelectorAll(".bp-popup[data-milestone-id]");
		const tokensMatch = /BATTLE TOKENS\s*([\d,]+)\s*\/\s*([\d,]+)/i.exec(body);
		if ((body.match(/Ready to claim/gi) ?? []).length === 0 && popups.length === 0) return;
		const readyClaims = listReadyClaimsFromDocument(document_);
		const { readyToClaim, readyToClaimArp } = countBattlePassClaims(document_);
		const state = {
			readyToClaim,
			readyToClaimArp,
			url: "/control-center/battle-pass/1",
			scrapedAt: new Date().toISOString()
		};
		if (readyClaims.length > 0) state.readyClaims = readyClaims;
		if (tokensMatch?.[1] && tokensMatch[2]) {
			state.tokens = Number(tokensMatch[1].replaceAll(",", ""));
			state.tokensMax = Number(tokensMatch[2].replaceAll(",", ""));
		}
		applyBattlePassCountdown(state, body);
		return state;
	}
	var BATTLE_PASS_ENDS_RE = /battle\s*pass\s*ends?\s*in\s*(\d{1,3}(?:\s*:\s*\d{1,2}){2,3})/i;
	function applyBattlePassCountdown(state, body) {
		const endsMatch = BATTLE_PASS_ENDS_RE.exec(body);
		if (!endsMatch?.[1]) return;
		const raw = endsMatch[1].replaceAll(/\s+/g, " ").trim();
		state.endsInText = raw;
		const remaining = parseBattlePassCountdownMs(raw);
		if (remaining !== void 0) state.endsAt = new Date(Date.now() + remaining).toISOString();
	}
	function parseBattlePassCountdownMs(text) {
		const parts = text.trim().split(":").map((part) => Number(part.trim())).filter((part) => Number.isFinite(part));
		if (parts.length < 3 || parts.length > 4) return;
		const seconds = parts.at(-1) ?? 0;
		const minutes = parts.at(-2) ?? 0;
		const hours = parts.at(-3) ?? 0;
		return ((((parts.length === 4 ? parts[0] ?? 0 : 0) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1e3;
	}
	function battlePassRemainingMs(battlePass, now = Date.now()) {
		if (!battlePass) return;
		if (battlePass.endsAt) {
			const endsAt = Date.parse(battlePass.endsAt);
			if (!Number.isNaN(endsAt)) return Math.max(0, endsAt - now);
		}
		if (!battlePass.endsInText || !battlePass.scrapedAt) return;
		const parsed = parseBattlePassCountdownMs(battlePass.endsInText);
		const scrapedAt = Date.parse(battlePass.scrapedAt);
		if (parsed === void 0 || Number.isNaN(scrapedAt)) return;
		return Math.max(0, parsed - (now - scrapedAt));
	}
	function mergeBattlePassScrape(scraped, previous) {
		if (scraped.endsAt || !previous?.endsAt) return scraped;
		const merged = {
			...scraped,
			endsAt: previous.endsAt
		};
		if (!merged.endsInText && previous.endsInText) merged.endsInText = previous.endsInText;
		return merged;
	}
	function applyBattlePassEndFromDocument(next, document_) {
		if (!next.battlePass) return;
		const battlePass = { ...next.battlePass };
		applyBattlePassCountdown(battlePass, pageText(document_));
		next.battlePass = battlePass;
	}
	function listReadyClaimsFromDocument(document_) {
		const claims = [];
		const popups = document_.querySelectorAll(".bp-popup[data-milestone-id]");
		for (const popup of popups) {
			if (!(popup instanceof HTMLElement)) continue;
			if (!(popup.dataset.milestoneId ?? "")) continue;
			claims.push(...readyClaimsFromPopup(popup));
		}
		return uniqueReadyClaims(claims);
	}
	function readyClaimFromButton(button, popup) {
		const form = button.closest("form");
		const claimPath = form?.getAttribute("action")?.trim() || void 0;
		const csrfToken = form?.querySelector("input[name=\"_csrf_token\"]")?.value;
		const claim = {
			milestoneId: (form instanceof HTMLElement ? form.dataset.milestoneId : void 0) ?? popup.dataset.milestoneId ?? "",
			isArp: isArpClaimPopup(popup)
		};
		if (claimPath) claim.claimPath = claimPath;
		if (csrfToken) claim.csrfToken = csrfToken;
		if (!claimPath) claim.body = {
			...datasetRecord(popup),
			...datasetRecord(button)
		};
		return claim;
	}
	function readyClaimsFromPopup(popup) {
		return [...popup.querySelectorAll(".bp-popup__claim-btn")].flatMap((button) => {
			if (!(button instanceof HTMLElement)) return [];
			return [readyClaimFromButton(button, popup)];
		});
	}
	function countBattlePassClaims(document_) {
		const readyClaims = listReadyClaimsFromDocument(document_);
		if (readyClaims.length > 0) return {
			readyToClaim: readyClaims.length,
			readyToClaimArp: readyClaims.filter((claim) => claim.isArp).length
		};
		const legacy = (pageText(document_).match(/Ready to claim/gi) ?? []).length;
		return {
			readyToClaim: legacy,
			readyToClaimArp: legacy
		};
	}
	function isBattlePassArpRewardTitle(title) {
		if (/ARP\s*Boost/i.test(title)) return true;
		return /^\d[\d,]*\s*ARP$/i.test(title.trim());
	}
	function battlePassPopupTitle(popup) {
		return popup.querySelector(".bp-popup__title")?.textContent?.trim() ?? "";
	}
	function isArpClaimPopup(popup) {
		return isBattlePassArpRewardTitle(battlePassPopupTitle(popup));
	}
	function claimIdentity(claim) {
		return claim.claimPath ?? claim.milestoneId;
	}
	function uniqueReadyClaims(claims) {
		const seen = new Set();
		const unique = [];
		for (const claim of claims) {
			const key = claimIdentity(claim);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			unique.push(claim);
		}
		return unique;
	}
	function claimButtonIdentity(button, popup) {
		return button.closest("form")?.getAttribute("action")?.trim() || popup.dataset.milestoneId || "";
	}
	function pushUniqueClaimButton(items, seen, button, popup) {
		if (!(button instanceof HTMLElement)) return;
		const key = claimButtonIdentity(button, popup);
		if (!key || seen.has(key)) return;
		seen.add(key);
		items.push({
			button,
			popup
		});
	}
	function listBattlePassClaimButtons(document_ = document, options = {}) {
		const shouldSkipArpBoosts = options.shouldSkipArpBoosts === true;
		const popups = document_.querySelectorAll(".bp-popup[data-milestone-id]");
		const items = [];
		const seen = new Set();
		for (const popup of popups) {
			if (!(popup instanceof HTMLElement)) continue;
			if (shouldSkipArpBoosts && isArpClaimPopup(popup)) continue;
			for (const button of popup.querySelectorAll(".bp-popup__claim-btn")) pushUniqueClaimButton(items, seen, button, popup);
		}
		return items;
	}
	function delay$2(ms) {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}
	var CLAIM_QUEUE_GAP_MS = 1500;
	async function waitWhile(isWaiting, timeoutMs, intervalMs = 100) {
		const startedAt = Date.now();
		while (isWaiting() && Date.now() - startedAt < timeoutMs) await delay$2(intervalMs);
	}
	var claimEndpointCache = {};
	function jsonishId(value) {
		return /^\d+$/.test(value) ? Number(value) : value;
	}
	function datasetRecord(element) {
		const record = {};
		for (const [key, value] of Object.entries(element.dataset)) {
			if (value === void 0 || value === "") continue;
			record[key] = jsonishId(value);
		}
		return record;
	}
	function isBattlePassClaimPath(path) {
		const normalized = path.toLowerCase();
		if (/giveaway|marketplace|ucf\/show|community-giveaway|vote\//.test(normalized)) return false;
		const hasClaim = /claim/.test(normalized);
		const hasBattlePass = /battle-?pass/.test(normalized);
		const hasMilestone = /milestone/.test(normalized);
		return hasClaim && (hasBattlePass || hasMilestone);
	}
	function endpointFromHref(raw) {
		let path = raw.trim();
		try {
			const url = new URL(path, location.origin);
			if (url.origin !== location.origin) return;
			path = `${url.pathname}${url.search}`;
		} catch {
			return;
		}
		if (!isBattlePassClaimPath(path)) return;
		const hasIdInPath = /\/\d+\/?$/.test(urlPathname(path));
		return {
			path: hasIdInPath ? path.replace(/\/\d+\/?$/, "") : path,
			hasIdInPath,
			idParameter: "milestoneId"
		};
	}
	function urlPathname(path) {
		const q = path.indexOf("?");
		return q === -1 ? path : path.slice(0, q);
	}
	function firstClaimEndpoint(candidates) {
		for (const candidate of candidates) {
			if (!candidate) continue;
			const endpoint = endpointFromHref(candidate);
			if (endpoint) return endpoint;
		}
	}
	function endpointFromClaimMarkup(document_) {
		for (const item of listBattlePassClaimButtons(document_)) {
			const endpoint = firstClaimEndpoint([
				item.button.closest("form")?.getAttribute("action") ?? void 0,
				item.button.getAttribute("href") ?? void 0,
				item.button.getAttribute("formaction") ?? void 0,
				item.button.dataset.url,
				item.button.dataset.href,
				item.button.dataset.action,
				item.popup.dataset.url,
				item.popup.dataset.href,
				item.popup.dataset.claimUrl
			]);
			if (endpoint) return endpoint;
		}
	}
	function idParameterFromSource(source) {
		const match = /(?:milestoneId|milestone_id|rewardId)\s*:/i.exec(source);
		return /rewardId/i.test(match?.[0] ?? "") ? "rewardId" : "milestoneId";
	}
	function endpointFromQuotedPath(path, source, hasIdInPathHint = false) {
		if (!isBattlePassClaimPath(path)) return;
		const hasIdInPath = hasIdInPathHint || /\/\d+\/?$/.test(urlPathname(path)) || /\$\{|\{id\}|\{milestone/i.test(path);
		return {
			path: hasIdInPath ? path.replace(/\/\d+\/?$/, "").replace(/\/$/, "") : path,
			hasIdInPath,
			idParameter: idParameterFromSource(source)
		};
	}
	function endpointFromScripts(source) {
		const concat = /['"](\/[^'"]*(?:claim[^'"]*(?:battle|milestone)|(?:battle-pass|milestone)[^'"]*claim)[^'"]*)['"]\s*\+/i.exec(source);
		if (concat?.[1]) {
			const fromConcat = endpointFromQuotedPath(concat[1], source, true);
			if (fromConcat) return fromConcat;
		}
		const quotedPath = /['"](\/[^'"]*(?:claim[^'"]*(?:battle|milestone)|(?:battle-pass|milestone)[^'"]*claim)[^'"]*)['"]/gi;
		let match;
		while (match = quotedPath.exec(source)) {
			const endpoint = endpointFromQuotedPath(match[1] ?? "", source);
			if (endpoint) return endpoint;
		}
		const ajaxPath = /(?:\.post|\.ajax|fetch)\(\s*['"](\/[^'"]+)['"]/gi;
		while (match = ajaxPath.exec(source)) {
			const endpoint = endpointFromQuotedPath(match[1] ?? "", source);
			if (endpoint) return endpoint;
		}
	}
	function collectInlineScriptText(document_) {
		return [...document_.querySelectorAll("script:not([src])")].map((script) => script.textContent ?? "").join("\n");
	}
	function pageScriptUrls(document_) {
		const urls = [];
		const add = (raw) => {
			if (!raw) return;
			try {
				const url = new URL(raw, location.origin);
				if (url.origin !== location.origin) return;
				urls.push(url.href);
			} catch {}
		};
		for (const script of document_.querySelectorAll("script[src]")) add(script.getAttribute("src"));
		for (const link of document_.querySelectorAll("link[rel=\"preload\"][as=\"script\"], link[as=\"script\"]")) add(link.getAttribute("href"));
		return [...new Set(urls)].filter((href) => !/jquery|bootstrap|gtag|gtm|recaptcha|cloudflare|analytics|hotjar|sentry/i.test(href)).slice(0, 24);
	}
	function endpointFromJquery(document_) {
		const readEvents = document_.defaultView?.jQuery?._data;
		if (typeof readEvents !== "function") return;
		const roots = [...document_.querySelectorAll(".bp-popup__claim-btn"), document_];
		if (document_.body) roots.push(document_.body);
		for (const root of roots) {
			const found = endpointFromScripts((readEvents(root, "events")?.click ?? []).map((entry) => String(entry.handler ?? "")).join("\n"));
			if (found) return found;
		}
	}
	async function endpointFromPageScripts(document_) {
		for (const href of pageScriptUrls(document_)) try {
			const text = await (await fetch(href)).text();
			const handlerAt = text.search(/bp-popup__claim-btn|claim-btn/i);
			const fromFile = handlerAt >= 0 ? endpointFromScripts(text.slice(Math.max(0, handlerAt - 2e3), handlerAt + 4e3)) ?? endpointFromScripts(text) : endpointFromScripts(text);
			if (fromFile) return fromFile;
		} catch {}
	}
	async function fetchBattlePassDocument() {
		try {
			const response = await fetch("/control-center/battle-pass/1", { headers: { Accept: "text/html" } });
			if (!response.ok) return;
			return new DOMParser().parseFromString(await response.text(), "text/html");
		} catch {
			return;
		}
	}
	function cacheClaimEndpoint(endpoint) {
		claimEndpointCache.value = endpoint;
		console.info("[AWA Toolkit] Battle Pass claim POST", endpoint.path, endpoint.hasIdInPath ? "(id in path)" : "");
		return endpoint;
	}
	async function searchDocumentForClaimEndpoint(document_) {
		return endpointFromClaimMarkup(document_) ?? endpointFromScripts(collectInlineScriptText(document_)) ?? endpointFromJquery(document_) ?? await endpointFromPageScripts(document_);
	}
	async function discoverBattlePassClaimEndpoint(document_) {
		if (claimEndpointCache.value) return claimEndpointCache.value;
		if (document_) {
			const found = await searchDocumentForClaimEndpoint(document_);
			if (found) return cacheClaimEndpoint(found);
		}
		if (!location.pathname.includes("/battle-pass") && !Boolean(document_ && document_ !== document)) {
			const fetched = await fetchBattlePassDocument();
			if (fetched) {
				const found = await searchDocumentForClaimEndpoint(fetched);
				if (found) return cacheClaimEndpoint(found);
			}
		}
	}
	function resolveClaimPath(endpoint, milestoneId) {
		if (!endpoint.hasIdInPath) return endpoint.path;
		const trimmed = endpoint.path.replace(/\/$/, "");
		if (trimmed.endsWith(`/${milestoneId}`)) return trimmed;
		return `${trimmed}/${milestoneId}`;
	}
	function resolveClaimBody(endpoint, claim) {
		if (claim.csrfToken) return { _csrf_token: claim.csrfToken };
		const body = { ...claim.body };
		if (endpoint && body[endpoint.idParameter] === void 0) body[endpoint.idParameter] = jsonishId(claim.milestoneId);
		return body;
	}
	function claimKey(claim) {
		return claimIdentity(claim);
	}
	function claimPostPath(claim, endpoint) {
		if (claim.claimPath) return claim.claimPath;
		if (endpoint && claim.milestoneId) return resolveClaimPath(endpoint, claim.milestoneId);
	}
	async function claimReadyViaApi(claims, endpoint) {
		const seen = new Set();
		const postedPaths = new Set();
		let claimed = 0;
		let hasPosted = false;
		for (const claim of uniqueReadyClaims(claims)) {
			const path = claimPostPath(claim, endpoint);
			const key = claimKey(claim);
			if (!path || seen.has(key)) continue;
			seen.add(key);
			if (hasPosted) await delay$2(CLAIM_QUEUE_GAP_MS);
			hasPosted = true;
			const result = await claimBattlePassReward(path, resolveClaimBody(endpoint, claim));
			postedPaths.add(path);
			if (!result.ok) continue;
			claimed += 1;
		}
		return {
			claimed,
			postedPaths
		};
	}
	function claimsFromLiveButtons(items) {
		return uniqueReadyClaims(items.map((item) => readyClaimFromButton(item.button, item.popup)));
	}
	async function clickRemainingClaimButtons(document_, options = {}) {
		const attempted = new WeakSet();
		const skipPaths = options.skipPaths ?? new Set();
		let claimed = 0;
		let hasClicked = false;
		while (claimed < 40) {
			const next = listBattlePassClaimButtons(document_, options).find((item) => {
				if (!item.button.isConnected || attempted.has(item.button)) return false;
				const path = claimButtonIdentity(item.button, item.popup);
				return !path || !skipPaths.has(path);
			});
			if (!next) break;
			attempted.add(next.button);
			const { button, popup } = next;
			const path = claimButtonIdentity(button, popup);
			if (path) skipPaths.add(path);
			if (hasClicked) await delay$2(CLAIM_QUEUE_GAP_MS);
			hasClicked = true;
			if (button.offsetParent === null) {
				popup.click();
				await delay$2(250);
			}
			button.click();
			await waitWhile(() => button.isConnected && popup.contains(button), 4e3);
			if (!button.isConnected || !popup.contains(button)) claimed += 1;
		}
		return claimed;
	}
	async function waitForBattlePassClaimButtons(document_, options = {}, timeoutMs = 8e3) {
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			const count = listBattlePassClaimButtons(document_, options).length;
			if (count > 0) return count;
			await delay$2(250);
		}
		return listBattlePassClaimButtons(document_, options).length;
	}
	async function claimAllBattlePassRewards(options = {}) {
		const shouldSkipArpBoosts = options.shouldSkipArpBoosts === true;
		const isOnBattlePassPage = location.pathname.includes("/battle-pass");
		if (isOnBattlePassPage) await waitForBattlePassClaimButtons(document, { shouldSkipArpBoosts });
		const liveDocument = isOnBattlePassPage ? document : void 0;
		let fetchedDocument;
		let targets;
		if (isOnBattlePassPage) targets = claimsFromLiveButtons(listBattlePassClaimButtons(document, { shouldSkipArpBoosts }));
		else {
			fetchedDocument = await fetchBattlePassDocument();
			targets = fetchedDocument ? listReadyClaimsFromDocument(fetchedDocument).filter((claim) => !shouldSkipArpBoosts || !claim.isArp) : [];
			if (targets.every((claim) => !claim.claimPath)) targets = (options.readyClaims ?? []).filter((claim) => Boolean(claim.claimPath) && (!shouldSkipArpBoosts || !claim.isArp));
		}
		const endpoint = await discoverBattlePassClaimEndpoint(liveDocument ?? fetchedDocument);
		const posted = targets.length > 0 ? await claimReadyViaApi(targets, endpoint) : {
			claimed: 0,
			postedPaths: new Set()
		};
		let claimed = posted.claimed;
		if (isOnBattlePassPage) {
			await waitWhile(() => listBattlePassClaimButtons(document, { shouldSkipArpBoosts }).length > 0, 1500);
			let remaining = listBattlePassClaimButtons(document, { shouldSkipArpBoosts }).length;
			if (remaining > 0) {
				claimed += await clickRemainingClaimButtons(document, {
					shouldSkipArpBoosts,
					skipPaths: posted.postedPaths
				});
				await waitWhile(() => listBattlePassClaimButtons(document, { shouldSkipArpBoosts }).length > 0, 1500);
				remaining = listBattlePassClaimButtons(document, { shouldSkipArpBoosts }).length;
			}
			return {
				claimed,
				remaining
			};
		}
		const uniqueTargets = new Set(targets.map((claim) => claimIdentity(claim))).size;
		return {
			claimed,
			remaining: Math.max(0, uniqueTargets - claimed)
		};
	}
	function battlePassClaimableArp(battlePass) {
		return battlePass?.readyToClaimArp ?? 0;
	}
	function battlePassReadyNonArp(battlePass) {
		const ready = battlePass?.readyToClaim ?? 0;
		return Math.max(0, ready - battlePassClaimableArp(battlePass));
	}
	function shouldSkipArpInBattlePassClaimAll(battlePass, shouldWaitForAllArpSwap) {
		return shouldWaitForAllArpSwap && battlePassClaimableArp(battlePass) > 0;
	}
	function shouldShowBattlePassClaimAll(battlePass, shouldWaitForAllArpSwap) {
		if (battlePassReadyNonArp(battlePass) > 0) return true;
		return (battlePass?.readyToClaim ?? 0) > 0 && !shouldWaitForAllArpSwap;
	}
	function battlePassClaimButtonLabel(shouldSkipArpBoosts, options) {
		if (shouldSkipArpBoosts) return "Claim rewards";
		return options?.compact === true ? "Claim all BP" : "Claim all";
	}
	function scrapeBattlePass() {
		if (!location.pathname.includes("/battle-pass")) return;
		return scrapeBattlePassFromDocument(document);
	}
	function isBattlePassDocumentReady(document_) {
		return Boolean(document_.querySelector(".bp-popup[data-milestone-id], .bp-popup__claim-btn, .bp-popup__claimed") || /Ready to claim/i.test(document_.body?.textContent ?? ""));
	}
	async function waitForBattlePassDocument(timeoutMs = 12e3) {
		if (isBattlePassDocumentReady(document)) return;
		await new Promise((resolve) => {
			let isSettled = false;
			const observer = new MutationObserver(() => {
				if (isBattlePassDocumentReady(document)) finish();
			});
			const timer = setTimeout(finish, timeoutMs);
			function finish() {
				if (isSettled) return;
				isSettled = true;
				observer.disconnect();
				clearTimeout(timer);
				resolve();
			}
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true
			});
		});
	}
	function battlePassClaimSignature(document_) {
		const { readyToClaim, readyToClaimArp } = countBattlePassClaims(document_);
		return `${readyToClaim}:${readyToClaimArp}`;
	}
	var DAILY_QUEST_STATUS_SELECTORS = [
		"[id^=\"control-center__daily-quest-status-\"]",
		"[id^=\"control-center__daily-quests-status-\"]",
		"[id^=\"control-center__weekend-quest-status-\"]",
		"[id^=\"control-center__quest-status-\"]"
	];
	var HEADER_NAME = /^(incomplete|complete|status|game|quest|quests|reward|arp)$/i;
	function dailyQuestStatusFromText(text) {
		const trimmed = text.trim();
		if (/^complete$/i.test(trimmed)) return "complete";
		if (/^incomplete$/i.test(trimmed)) return "incomplete";
	}
	function dailyQuestKind(name, href) {
		return /weekend/i.test(`${name} ${href ?? ""}`) ? "weekend" : "daily";
	}
	function pathnameFromHref(href) {
		if (!href) return;
		try {
			return new URL(href, "https://na.alienwarearena.com").pathname;
		} catch {
			return href.startsWith("/") ? href : void 0;
		}
	}
	function questNameFromRow(row) {
		const name = ([...row.querySelectorAll("a")].find((link) => {
			const href = link.getAttribute("href") ?? "";
			return /\/quests\//i.test(href) && !/\/steam\/quests\//i.test(href);
		})?.textContent ?? row.querySelector("a")?.textContent ?? [...row.querySelectorAll("td")].find((cell) => {
			const text = cell.textContent?.replaceAll(/\s+/g, " ").trim() ?? "";
			return text.length > 0 && !dailyQuestStatusFromText(text);
		})?.textContent)?.replaceAll(/\s+/g, " ").trim();
		if (!name || HEADER_NAME.test(name)) return;
		return name;
	}
	function statusTextFromRow(row) {
		return [...row.querySelectorAll("td, th, span, div")].find((cell) => dailyQuestStatusFromText(cell.textContent ?? ""))?.textContent?.trim() ?? "";
	}
	function buildDailyQuestRow(row, statusText) {
		const name = questNameFromRow(row);
		const status = dailyQuestStatusFromText(statusText);
		if (!name || !status) return;
		const href = pathnameFromHref(row.querySelector("a")?.getAttribute("href") ?? void 0);
		const parsed = {
			name,
			status,
			kind: dailyQuestKind(name, href)
		};
		if (href) parsed.href = href;
		return parsed;
	}
	function parseDailyQuestRowFromStatusCell(statusCell) {
		const row = statusCell.closest("tr") ?? statusCell.parentElement;
		if (!row) return;
		return buildDailyQuestRow(row, statusCell.textContent?.trim() ?? "");
	}
	function parseDailyQuestRowFromTableRow(row) {
		return buildDailyQuestRow(row, statusTextFromRow(row));
	}
	function scrapeDailyQuestRowsFromDocument(document_) {
		const card = findActivityCard(document_, /^Daily Quests$/i);
		if (!card) return [];
		const fromStatusIds = [];
		for (const selector of DAILY_QUEST_STATUS_SELECTORS) fromStatusIds.push(...[...card.querySelectorAll(selector)].map((cell) => parseDailyQuestRowFromStatusCell(cell)).filter((row) => row !== void 0));
		if (fromStatusIds.length > 0) return fromStatusIds;
		const tableRows = [...card.querySelectorAll("tr")].map((row) => parseDailyQuestRowFromTableRow(row)).filter((row) => row !== void 0);
		if (tableRows.length > 0) return tableRows;
		return [...card.querySelectorAll("li")].map((row) => parseDailyQuestRowFromTableRow(row)).filter((row) => row !== void 0);
	}
	function dailyQuestsCapFromRows(quests) {
		if (quests.length === 0) return;
		return remainingDailyQuestRowsFromList(quests).length > 0 ? "available" : "capped";
	}
	function remainingDailyQuestRowsFromList(quests) {
		return quests.filter((quest) => quest.status === "incomplete");
	}
	function remainingDailyQuestRows(siteState) {
		return remainingDailyQuestRowsFromList(siteState.dailyQuests?.quests ?? []);
	}
	function applyDailyQuestsFromDocument(next, document_) {
		const scraped = scrapeDailyQuestRowsFromDocument(document_);
		if (scraped.length === 0) return;
		next.dailyQuests = {
			scrapedAt: new Date().toISOString(),
			quests: scraped
		};
		const cap = dailyQuestsCapFromRows(scraped);
		if (cap) next.caps.dailyQuests = cap;
	}
	function readTimeOnSiteCap(body) {
		const tosBlock = /Time on Site[\s\S]{0,200}?Max ARP per day:\s*(\d+)[\s\S]{0,80}?Earned ARP:\s*(\d+)/i.exec(body);
		if (!tosBlock?.[1] || !tosBlock[2]) return;
		const capArp = Number(tosBlock[1]);
		const earnedArp = Number(tosBlock[2]);
		if (!Number.isFinite(capArp) || !Number.isFinite(earnedArp)) return;
		if (earnedArp >= BASE_ACTIVITY.timeOnSiteBasePerDay) return "capped";
		return earnedArp >= capArp ? "capped" : "available";
	}
	function parseTwitchArpStatus(document_) {
		const status = document_.querySelector("#control-center__twitch-arp-status")?.textContent?.trim() ?? "";
		const incompleteArp = /^Incomplete:\s*(\d+)\s*ARP/i.exec(status);
		if (incompleteArp?.[1] !== void 0) return {
			cap: "available",
			earnedArp: Number(incompleteArp[1])
		};
		if (/^Incomplete\b/i.test(status)) return { cap: "available" };
		const completeArp = /^Complete:\s*(\d+)\s*ARP/i.exec(status);
		if (completeArp?.[1] !== void 0) return {
			cap: "capped",
			earnedArp: Number(completeArp[1])
		};
		if (/^Complete\b/i.test(status)) return { cap: "capped" };
		return {};
	}
	function readWatchTwitchCapFromDocument(document_) {
		const fromStatus = parseTwitchArpStatus(document_).cap;
		if (fromStatus) return fromStatus;
		const card = findActivityCard(document_, /^Watch Twitch$/i);
		if (card && /Incomplete/i.test(card.textContent ?? "")) return "available";
		const maxReached = document_.querySelector("#control-center__twitch-max-reached");
		if (maxReached && !isElementVisiblyHidden(maxReached) && /Max Cap Reached/i.test(maxReached.textContent ?? "")) return "capped";
		return readWatchTwitchCap(pageText(document_));
	}
	function readWatchTwitchCap(body) {
		if (/Watch Twitch[\s\S]{0,400}?Incomplete:\s*\d+\s*ARP/i.test(body)) return "available";
		if (/Watch Twitch[\s\S]{0,400}?\bIncomplete\b/i.test(body)) return "available";
		if (/Watch Twitch[\s\S]{0,240}Max Cap Reached/i.test(body) && !/twitch-max-reached[^>]*display:\s*none/i.test(body)) return "capped";
		if (/Watch Twitch[\s\S]{0,80}\bComplete\b/i.test(body)) return "capped";
	}
	var TWITCH_MS_PER_ARP$2 = 6e4;
	function parseDailyArpTwitchData(document_) {
		const scripts = [...document_.querySelectorAll("script:not([src])")].map((script) => script.textContent ?? "").join("\n");
		const assignment = /dailyArpData\s*=\s*(\{[\s\S]*?\});/.exec(scripts)?.[1];
		if (!assignment) return;
		let parsed;
		try {
			parsed = JSON.parse(assignment);
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object" || !("twitchData" in parsed)) return;
		const twitch = parsed.twitchData;
		if (!twitch || typeof twitch !== "object") return;
		const data = twitch;
		const totalPoints = Number(data.totalPoints);
		if (!Number.isFinite(totalPoints)) return;
		const timeWatched = Number(data.timeWatched);
		const bonusPoints = Number(data.bonusPoints);
		return {
			totalPoints,
			timeWatched: Number.isFinite(timeWatched) ? timeWatched : 0,
			bonusPoints: Number.isFinite(bonusPoints) ? bonusPoints : 0,
			isUnderCap: isTwitchUnderCapFromData(data)
		};
	}
	function isTwitchUnderCapFromData(data) {
		if (typeof data.underCap === "boolean") return data.underCap;
		if (typeof data.isUnderCap === "boolean") return data.isUnderCap;
		return true;
	}
	function parseTwitchDailyCapArp(document_) {
		const body = pageText(document_);
		for (const pattern of [
			/only earn up to\s+(\d+)\s*ARP from Twitch/i,
			/Earn up to\s+(\d+)\s*ARP per day by watching participating Twitch/i,
			/watching Twitch[\s\S]{0,160}?earn up to\s+(\d+)\s*ARP every day/i,
			/Watch Twitch[\s\S]{0,240}?Max ARP per day:\s*(\d+)/i
		]) {
			const match = pattern.exec(body);
			if (!match?.[1]) continue;
			const value = Number(match[1]);
			if (value > 0) return value;
		}
	}
	function scrapeWatchTwitchProgressFromDocument(document_, previous) {
		const twitchData = parseDailyArpTwitchData(document_);
		const capFromPage = parseTwitchDailyCapArp(document_);
		const status = parseTwitchArpStatus(document_);
		if (!twitchData && capFromPage === void 0 && status.earnedArp === void 0 && status.cap === void 0) return previous;
		const capArp = capFromPage ?? previous?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay;
		let isUnderCap;
		if (status.cap === "capped") isUnderCap = false;
		else if (status.cap === "available") isUnderCap = true;
		else if (twitchData) isUnderCap = twitchData.isUnderCap;
		else isUnderCap = previous?.isUnderCap ?? true;
		const parsedArp = status.earnedArp ?? twitchData?.totalPoints ?? previous?.baseArp ?? 0;
		const baseArp = isUnderCap ? parsedArp : Math.max(parsedArp, capArp);
		const remainingArp = isUnderCap ? Math.max(0, capArp - baseArp) : 0;
		return {
			scrapedAt: new Date().toISOString(),
			baseArp,
			bonusArp: twitchData?.bonusPoints ?? previous?.bonusArp ?? 0,
			timeWatched: twitchData?.timeWatched ?? previous?.timeWatched ?? 0,
			isUnderCap,
			capArp,
			remainingMs: remainingArp * TWITCH_MS_PER_ARP$2
		};
	}
	function twitchWatchRemainingMs(state, twitchFlat = 0, now = new Date()) {
		const progress = state?.watchTwitch;
		const baseCap = progress?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay;
		const isFreshProgress = progress !== void 0 && utcDateString(new Date(progress.scrapedAt)) === utcDateString(now);
		if (state?.caps.watchTwitch === "capped" || isFreshProgress && progress && !progress.isUnderCap) return 0;
		const earned = isFreshProgress && progress ? progress.baseArp : 0;
		return Math.max(0, baseCap + twitchFlat - earned) * TWITCH_MS_PER_ARP$2;
	}
	function readQuestStatusesFromCard(card) {
		const statuses = [...card.querySelectorAll("td, th, span, div, li")].map((element) => element.textContent?.trim() ?? "").filter((text) => /^(Incomplete|Complete)$/i.test(text));
		if (statuses.some((status) => /^Incomplete$/i.test(status))) return "available";
		if (statuses.some((status) => /^Complete$/i.test(status))) return "capped";
		const text = card.textContent ?? "";
		if (/Incomplete/i.test(text)) return "available";
		if (/\bComplete\b/i.test(text)) return "capped";
	}
	function readSteamQuestsCap(body) {
		const steamSection = /Steam Quests([\s\S]{0,8000}?)(?=Watch Twitch|Discord Poll|Battle Pass|Time on Site|$)/i.exec(body);
		if (!steamSection?.[1]) return;
		const section = steamSection[1];
		if (/Incomplete/i.test(section)) return "available";
		if (/\bComplete\b/i.test(section)) return "capped";
	}
	function readCapFromCardOrText(document_, cardTitle, textFallback) {
		const card = findActivityCard(document_, cardTitle);
		if (card) return readQuestStatusesFromCard(card) ?? textFallback(pageText(document_));
		return textFallback(pageText(document_));
	}
	function readSteamQuestsCapFromDocument(document_) {
		const fromRows = steamQuestsCapFromRows(scrapeSteamQuestRowsFromDocument(document_));
		if (fromRows) return fromRows;
		return readCapFromCardOrText(document_, /^Steam Quests$/i, readSteamQuestsCap);
	}
	function readDailyQuestsCap(body) {
		const section = /Daily Quests([\s\S]{0,1200}?)(?=Steam Quests|Watch Twitch|OLD SCHOOL|Community Event|$)/i.exec(body);
		if (!section?.[1]) return;
		if (/Incomplete/i.test(section[1])) return "available";
		if (/\bComplete\b/i.test(section[1])) return "capped";
	}
	function readDailyQuestsCapFromDocument(document_) {
		const fromRows = dailyQuestsCapFromRows(scrapeDailyQuestRowsFromDocument(document_));
		if (fromRows) return fromRows;
		return readCapFromCardOrText(document_, /^Daily Quests$/i, readDailyQuestsCap);
	}
	function readDailyCalendarCap(body) {
		if (/Daily Login Calendar[\s\S]{0,120}Claimed/i.test(body)) return "capped";
		if (/Daily Login Calendar[\s\S]{0,120}\bClaim\b/i.test(body)) return "available";
		if (!/Today'?s Reward|28-Day Daily Login Rewards/i.test(body)) return;
		if (/Today'?s Reward[\s\S]{0,240}Claimed/i.test(body)) return "capped";
		if (/Today'?s Reward[\s\S]{0,240}\bClaim\b/i.test(body)) return "available";
		return "capped";
	}
	function readDailyCalendarCapFromDocument(document_) {
		const fromText = readDailyCalendarCap(pageText(document_));
		if (fromText) return fromText;
		const card = findActivityCard(document_, /^(Today'?s Reward|28-Day Daily Login Rewards|Daily Login)/i);
		if (!card) return;
		const claimControl = [...card.querySelectorAll("button, a")].find((element) => /^claim$/i.test(element.textContent?.trim() ?? ""));
		if (!claimControl) return "capped";
		if (claimControl instanceof HTMLButtonElement && claimControl.disabled) return "capped";
		if (claimControl.getAttribute("aria-disabled") === "true") return "capped";
		return "available";
	}
	function hasVotedCurrentDiscordPoll(arpLog, now = new Date()) {
		if (!arpLog || arpLog.recent.length === 0) return false;
		const pollStartDate = utcDateString(lastDiscordPollPostAt(now));
		return arpLog.recent.some((entry) => /Discord Poll/i.test(entry.action) && entry.date !== void 0 && entry.date >= pollStartDate);
	}
	function applyArpLogActivityCaps(caps, arpLog, now = new Date()) {
		if (!arpLog || arpLog.recent.length === 0) return caps;
		const today = utcDateString(now);
		const next = { ...caps };
		if (arpLog.recent.filter((entry) => entry.date === today).some((entry) => /Daily Login Calendar/i.test(entry.action))) next.dailyCalendar = "capped";
		next.discordPoll = hasVotedCurrentDiscordPoll(arpLog, now) ? "capped" : "available";
		return next;
	}
	function scrapeControlCenterCapsFromDocument(document_) {
		const body = pageText(document_);
		const caps = {};
		const timeOnSite = readTimeOnSiteCap(body);
		if (timeOnSite) caps.timeOnSite = timeOnSite;
		const watchTwitch = readWatchTwitchCapFromDocument(document_);
		if (watchTwitch) caps.watchTwitch = watchTwitch;
		const steamQuests = readSteamQuestsCapFromDocument(document_);
		if (steamQuests) caps.steamQuests = steamQuests;
		const dailyCalendar = readDailyCalendarCapFromDocument(document_);
		if (dailyCalendar) caps.dailyCalendar = dailyCalendar;
		const dailyQuests = readDailyQuestsCapFromDocument(document_);
		if (dailyQuests) caps.dailyQuests = dailyQuests;
		caps.steamCommunityEvent = scrapeLiveCommunityEventBanner(document_) ? "available" : "capped";
		return caps;
	}
	function scrapeControlCenterCaps() {
		return scrapeControlCenterCapsFromDocument(document);
	}
	var CONTROL_CENTER_WIDGET = "[id^=\"control-center__\"], a.community-event-banner";
	function isControlCenterDocumentReady(document_) {
		return Boolean(document_.querySelector(CONTROL_CENTER_WIDGET));
	}
	function isControlCenterTwitchDataReady(document_) {
		if (document_.querySelector("#control-center__twitch-arp-status")?.textContent?.trim()) return true;
		if (document_ !== document) return parseDailyArpTwitchData(document_) !== void 0;
		return false;
	}
	function isControlCenterActivityReady(document_) {
		return isControlCenterDocumentReady(document_) && isControlCenterTwitchDataReady(document_);
	}
	function controlCenterActivitySignature(document_) {
		const caps = scrapeControlCenterCapsFromDocument(document_);
		const twitch = scrapeWatchTwitchProgressFromDocument(document_);
		return [
			caps.watchTwitch,
			caps.steamQuests,
			caps.timeOnSite,
			caps.dailyCalendar,
			caps.dailyQuests,
			twitch?.baseArp,
			twitch?.isUnderCap,
			twitch?.timeWatched,
			twitch?.bonusArp
		].join(":");
	}
	async function waitForControlCenterDocument(timeoutMs = 12e3) {
		if (isControlCenterActivityReady(document)) return;
		await new Promise((resolve) => {
			let isSettled = false;
			const observer = new MutationObserver(() => {
				if (isControlCenterActivityReady(document)) finish();
			});
			const timer = setTimeout(finish, timeoutMs);
			function finish() {
				if (isSettled) return;
				isSettled = true;
				observer.disconnect();
				clearTimeout(timer);
				resolve();
			}
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true
			});
		});
	}
	function isListPriceVaultClaim(game) {
		return game.isAuction !== true;
	}
	function isVaultTierMet(game, userTier) {
		if (userTier === void 0 || game.minTier === void 0) return true;
		return userTier >= game.minTier;
	}
	function vaultPayArp(price, discountPct = 0) {
		return Math.ceil(price * (1 - Math.min(1, Math.max(0, discountPct))) - 1e-9);
	}
	function vaultGamePayArp(game, discountPct = 0) {
		return vaultPayArp(game.price, discountPct);
	}
	function canAffordVaultPrice(redeemableArp, payArp) {
		if (redeemableArp === void 0) return true;
		return redeemableArp >= payArp;
	}
	function isPostedListPriceVaultGame(game) {
		return game.inStock && isListPriceVaultClaim(game);
	}
	function isAffordableVaultOffer(game, state, discountPct = 0, availableArp = state.arpLog?.redeemableArp) {
		if (!isPostedListPriceVaultGame(game)) return false;
		if (!isVaultTierMet(game, state.userArpTier)) return false;
		return canAffordVaultPrice(availableArp, vaultGamePayArp(game, discountPct));
	}
	function hasPostedListPriceVaultGames(state) {
		return state.gameVault.some((game) => isPostedListPriceVaultGame(game));
	}
	function canAffordAnyVaultOffer(state, discountPct = 0, availableArp = state.arpLog?.redeemableArp) {
		return state.gameVault.some((game) => isAffordableVaultOffer(game, state, discountPct, availableArp));
	}
	function isClaimableVaultGame(game, state, discountPct = 0) {
		return game.purchasable === true && isAffordableVaultOffer(game, state, discountPct);
	}
	function isVaultStockForUser(game, userTier) {
		return game.purchasable === true && isListPriceVaultClaim(game) && isVaultTierMet(game, userTier);
	}
	function isGameVaultStockOpen(state) {
		return state.gameVault.some((game) => isVaultStockForUser(game, state.userArpTier));
	}
	function isGameVaultCurrentlyOpen(state, discountPct = 0) {
		return state.gameVault.some((game) => isClaimableVaultGame(game, state, discountPct));
	}
	var GAME_VAULT_EQUIP_BUFFER_MS = 18e5;
	function gameVaultCycleId(state) {
		if (state.gameVaultOpensAt) return state.gameVaultOpensAt;
		if (isGameVaultStockOpen(state)) return "open";
	}
	function gameVaultOpensAtMs(state) {
		const opensAt = parseTimestamp$1(state.gameVaultOpensAt);
		return Number.isFinite(opensAt) ? opensAt : void 0;
	}
	function willMissDiscountEquipBeforeOpen(lockUntilMs, state, now = Date.now()) {
		const opensAt = gameVaultOpensAtMs(state);
		if (opensAt === void 0 || opensAt <= now) return false;
		return lockUntilMs + GAME_VAULT_EQUIP_BUFFER_MS > opensAt;
	}
	function gameVaultCatalogPrice(state, discountPct = 0) {
		return state.gameVault.find((game) => isClaimableVaultGame(game, state, discountPct))?.price ?? 0;
	}
	function scrapeGameVaultTimerMsFromDocument(document_) {
		const timer = document_.querySelector("#game-vault-timer");
		const ms = parseTimestamp$1((timer?.dataset.unlockDate ?? timer?.dataset.endDate ?? timer?.dataset.lockDate ?? timer?.dataset.closeDate)?.trim());
		return Number.isFinite(ms) ? ms : void 0;
	}
	function scrapeGameVaultFromDocument(document_) {
		const items = document_.querySelectorAll([".gamevault-marketplace-product[data-product-price]", ".marketplace-game-product[data-product-price]"].join(", "));
		const result = [];
		const seen = new Set();
		for (const item of items) {
			const priceRaw = item.dataset.productPrice;
			if (priceRaw === void 0) continue;
			const price = Number(priceRaw);
			if (Number.isNaN(price) || price <= 0) continue;
			const id = item.dataset.productId ?? `${price}:${item.dataset.productName ?? ""}`;
			if (seen.has(id)) continue;
			seen.add(id);
			const isAuction = item.dataset.isBlindAuction === "true" || item.classList.contains("auction-game");
			const isInStock = item.dataset.productInStock !== "false";
			const isDisabled = item.dataset.productDisabled === "true";
			const minTierRaw = item.dataset.arpTier;
			const minTier = minTierRaw === void 0 ? void 0 : Number(minTierRaw);
			const nextItem = {
				name: item.dataset.productName?.trim() || item.querySelector(".product-name, .gv-product-name, h3, h4")?.textContent?.trim() || item.getAttribute("title") || "Game Vault item",
				price,
				inStock: isInStock && !isAuction,
				purchasable: isInStock && !isDisabled && !isAuction,
				isAuction
			};
			if (minTier !== void 0 && Number.isFinite(minTier)) nextItem.minTier = minTier;
			result.push(nextItem);
		}
		return result;
	}
	function scrapeUserArpTierFromDocument(document_) {
		return readPageArpTier(document_);
	}
	function applyGameVaultSchedule(next, timerMs, isOpen, now) {
		if (isOpen) {
			const existingOpen = parseTimestamp$1(next.gameVaultOpensAt);
			if (!Number.isFinite(existingOpen) || existingOpen > now) next.gameVaultOpensAt = new Date(now).toISOString();
			return;
		}
		if (timerMs !== void 0 && timerMs > now) {
			next.gameVaultOpensAt = new Date(timerMs).toISOString();
			return;
		}
		delete next.gameVaultOpensAt;
	}
	function applyGameVaultDocument(next, document_) {
		const tier = scrapeUserArpTierFromDocument(document_);
		if (tier !== void 0) next.userArpTier = tier;
		applyRedeemableArpFromDocument(next, document_);
		const vault = scrapeGameVaultFromDocument(document_);
		const timerMs = scrapeGameVaultTimerMsFromDocument(document_);
		if (timerMs === void 0 && vault.length === 0) return;
		if (vault.length > 0) next.gameVault = vault;
		applyGameVaultSchedule(next, timerMs, vault.some((game) => isVaultStockForUser(game, next.userArpTier)), Date.now());
	}
	var SITE_STATE_KEY = "artifactSiteState";
	var DEFAULT_CAPS = {
		timeOnSite: "unknown",
		steamQuests: "unknown",
		watchTwitch: "unknown",
		dailyCalendar: "unknown",
		discordPoll: "unknown",
		dailyQuests: "unknown",
		steamCommunityEvent: "unknown"
	};
	function normalizeCaps(raw) {
		const caps = raw ?? {};
		return {
			...DEFAULT_CAPS,
			...caps,
			dailyQuests: caps.dailyQuests ?? caps.communityEvent ?? "unknown",
			steamCommunityEvent: caps.steamCommunityEvent ?? "unknown"
		};
	}
	function isSiteState(value) {
		return typeof value === "object" && !!value && "caps" in value;
	}
	async function loadSiteState() {
		const raw = await _GM.getValue(SITE_STATE_KEY);
		if (!raw) return;
		try {
			const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!isSiteState(parsed)) return;
			return {
				...parsed,
				caps: normalizeCaps(parsed.caps)
			};
		} catch {
			return;
		}
	}
	async function saveSiteState(state) {
		await _GM.setValue(SITE_STATE_KEY, JSON.stringify(state));
	}
	function applyWatchTwitchFromDocument(next, document_) {
		const progress = scrapeWatchTwitchProgressFromDocument(document_, next.watchTwitch);
		if (progress) next.watchTwitch = progress;
	}
	function applyControlCenterPage(next) {
		if (!isControlCenterDocumentReady(document)) return;
		Object.assign(next.caps, scrapeControlCenterCaps());
		applySteamQuestsFromDocument(next, document);
		applyDailyQuestsFromDocument(next, document);
		applyWatchTwitchFromDocument(next, document);
		applyBattlePassEndFromDocument(next, document);
		const banner = scrapeLiveCommunityEventBanner(document);
		if (banner) {
			next.caps.steamCommunityEvent = "available";
			if (next.communityEvent && !next.communityEvent.isLive) next.communityEvent = {
				...next.communityEvent,
				isLive: true,
				url: banner.url,
				...banner.title && next.communityEvent.title === void 0 && { title: banner.title }
			};
			return;
		}
		if (!next.communityEvent?.isLive) next.caps.steamCommunityEvent = "capped";
	}
	function applyCommunityEventPage(next) {
		const event = mergeCommunityEventScrape(scrapeCommunityEventFromDocument(document, location.pathname), next.communityEvent, { source: "visit" });
		next.communityEvent = event;
		next.caps.steamCommunityEvent = event.isLive ? "available" : "capped";
	}
	function applyLiveDocumentToSiteState(next) {
		const path = location.pathname;
		const userArpTier = scrapeUserArpTierFromDocument(document);
		if (userArpTier !== void 0) next.userArpTier = userArpTier;
		applyRedeemableArpFromDocument(next, document);
		if (path.includes("/control-center") && !path.includes("/battle-pass")) applyControlCenterPage(next);
		if (path.includes("/steam/questsetup") || path.includes("/rewards/terms") || path.includes("/faq-contact")) applyWatchTwitchFromDocument(next, document);
		if (path.includes("/marketplace") || path.includes("/game-vault")) applyGameVaultDocument(next, document);
		if (path.includes("/battle-pass")) {
			const battlePass = scrapeBattlePass();
			if (battlePass) next.battlePass = mergeBattlePassScrape(battlePass, next.battlePass);
		}
		if (path.includes("/arp-log") && isArpLogDocumentReady(document)) next.arpLog = mergeArpLogScrape(scrapeArpLogFromDocument(document), next.arpLog);
		if (path.includes("/steam/community-event")) applyCommunityEventPage(next);
		if (/\/steam\/quests\/.+/.test(path)) applySteamQuestDetailFromDocument(next, document, path);
		next.caps = applyArpLogActivityCaps(next.caps, next.arpLog);
		if (next.communityEvent) next.communityEvent = reconcileCommunityEventWithArpLog(next.communityEvent, next.arpLog);
	}
	async function refreshSiteStateFromPage() {
		const previous = await loadSiteState() ?? {
			updatedAt: new Date().toISOString(),
			caps: { ...DEFAULT_CAPS },
			gameVault: []
		};
		if (location.pathname.includes("/arp-log")) await waitForArpLogDocument();
		if (location.pathname.includes("/control-center") && !location.pathname.includes("/battle-pass")) await waitForControlCenterDocument();
		const next = {
			...previous,
			updatedAt: new Date().toISOString(),
			caps: { ...previous.caps }
		};
		applyLiveDocumentToSiteState(next);
		await saveSiteState(next);
		return next;
	}
	function watchLiveSiteStatePage(options) {
		if (!options.isPage) return;
		if (document.documentElement.dataset[options.datasetFlag] === "1") return;
		document.documentElement.dataset[options.datasetFlag] = "1";
		let debounceTimer;
		let lastSignature = "";
		let isPersisting = false;
		let isPendingAfterPersist = false;
		const persistIfChanged = async () => {
			if (!options.isReady(document)) return;
			const signature = options.signature(document);
			if (signature === lastSignature) return;
			if (isPersisting) {
				isPendingAfterPersist = true;
				return;
			}
			isPersisting = true;
			try {
				const state = await refreshSiteStateFromPage();
				lastSignature = signature;
				await options.onPersist?.(state);
			} finally {
				isPersisting = false;
				if (isPendingAfterPersist) {
					isPendingAfterPersist = false;
					persistIfChanged();
				}
			}
		};
		const schedule = () => {
			if (debounceTimer !== void 0) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = void 0;
				persistIfChanged();
			}, 250);
		};
		(async () => {
			await options.waitForReady();
			await persistIfChanged();
			new MutationObserver(schedule).observe(document.documentElement, {
				childList: true,
				subtree: true,
				characterData: true
			});
			if (!options.clickSelector) return;
			const clickSelector = options.clickSelector;
			document.addEventListener("click", (event) => {
				const target = event.target;
				if (!(target instanceof Element)) return;
				if (target.closest(clickSelector)) schedule();
			}, { capture: true });
		})();
	}
	function watchBattlePassPage(onPersist) {
		watchLiveSiteStatePage({
			isPage: location.pathname.includes("/battle-pass"),
			datasetFlag: "aoBpWatch",
			isReady: isBattlePassDocumentReady,
			signature: battlePassClaimSignature,
			waitForReady: waitForBattlePassDocument,
			...onPersist && { onPersist },
			clickSelector: ".bp-popup__claim-btn"
		});
	}
	function watchControlCenterPage(onPersist) {
		watchLiveSiteStatePage({
			isPage: location.pathname.includes("/control-center") && !location.pathname.includes("/battle-pass"),
			datasetFlag: "aoCcWatch",
			isReady: isControlCenterActivityReady,
			signature: controlCenterActivitySignature,
			waitForReady: waitForControlCenterDocument,
			...onPersist && { onPersist }
		});
	}
	function watchArpLogPage(onPersist) {
		watchLiveSiteStatePage({
			isPage: location.pathname.includes("/arp-log"),
			datasetFlag: "aoArpWatch",
			isReady: isArpLogDocumentReady,
			signature: arpLogSignature,
			waitForReady: waitForArpLogDocument,
			...onPersist && { onPersist }
		});
	}
	async function applySteamFreeToPlayResolution(next) {
		await resolveSiteStateSteamFreeToPlay(next);
		const cap = steamQuestsCapFromRows(next.steamQuests?.quests ?? []);
		if (cap) next.caps.steamQuests = cap;
	}
	function emptySiteState() {
		return {
			updatedAt: new Date(0).toISOString(),
			caps: { ...DEFAULT_CAPS },
			gameVault: []
		};
	}
	function isActivityAvailable(caps, key) {
		return caps[key] !== "capped";
	}
	function isActivityPending(caps, key) {
		const status = caps[key];
		if (status === "available") return true;
		if (status === "capped") return false;
		return [
			"steamQuests",
			"dailyQuests",
			"steamCommunityEvent"
		].includes(key);
	}
	function resolveNow(context) {
		return context.nowMs ?? Date.now();
	}
	function combinations(items, k) {
		if (k === 0) return [[]];
		if (items.length < k) return [];
		const [first, ...rest] = items;
		if (first === void 0) return [];
		const withFirst = combinations(rest, k - 1).map((c) => [first, ...c]);
		const withoutFirst = combinations(rest, k);
		return [...withFirst, ...withoutFirst];
	}
	function msUntilNextUtcMidnight(now = Date.now()) {
		const date = new Date(now);
		return Math.max(0, Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - now);
	}
	function msUntilNextSteamQuestWeek(now = Date.now()) {
		const date = new Date(now);
		const day = date.getUTCDay();
		const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
		return Math.max(0, Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + daysUntilMonday) - now);
	}
	function isResetInWearWindow(delayMs, waitMs = 0, horizonMs = COOLDOWN_MS) {
		return delayMs > waitMs && delayMs <= waitMs + horizonMs;
	}
	var MS_PER_DAY$1 = 864e5;
	var UTC_DAILY_END_BUFFER_MS = 36e5;
	function wearWindowOverlapMs(availableFromMs, availableUntilMs, waitMs = 0, horizonMs = COOLDOWN_MS) {
		return Math.max(0, Math.min(availableUntilMs, waitMs + horizonMs) - Math.max(availableFromMs, waitMs));
	}
	function canCompleteInWearWindow(availableFromMs, availableUntilMs, waitMs, durationMs, horizonMs = COOLDOWN_MS) {
		const overlap = wearWindowOverlapMs(availableFromMs, availableUntilMs, waitMs, horizonMs);
		if (durationMs <= 0) return overlap > 0;
		return overlap >= durationMs;
	}
	function canCompleteOutsideWearWindow(availableFromMs, availableUntilMs, waitMs, durationMs, horizonMs = COOLDOWN_MS, deadlineBufferMs = UTC_DAILY_END_BUFFER_MS) {
		const deadline = availableUntilMs - deadlineBufferMs;
		const lockStartMs = waitMs === 0 && availableFromMs <= 0 ? availableFromMs + durationMs : waitMs;
		if (Math.min(deadline, lockStartMs) - availableFromMs >= durationMs) return true;
		return deadline - Math.max(availableFromMs, waitMs + horizonMs) >= durationMs;
	}
	function completableUtcDayStarts(waitMs, durationMs, options) {
		const midnight = msUntilNextUtcMidnight(options.now ?? Date.now());
		const horizonMs = options.horizonMs ?? 864e5;
		const starts = [];
		if (options.todayAvailable && canCompleteInWearWindow(0, midnight, waitMs, durationMs, horizonMs)) starts.push(0);
		for (let day = 0; day < 3; day += 1) {
			const dayStart = midnight + day * MS_PER_DAY$1;
			if (dayStart >= waitMs + horizonMs) break;
			if (canCompleteInWearWindow(dayStart, dayStart + MS_PER_DAY$1, waitMs, durationMs, horizonMs)) starts.push(dayStart);
		}
		return starts;
	}
	function isWeeklyForcedIntoLock(weekendMs, waitMs, horizonMs = COOLDOWN_MS) {
		return waitMs + horizonMs >= weekendMs;
	}
	function comboEquipWaitMs(combo, owned, settings, slotLocks, now = Date.now()) {
		if (isSameLoadout$1(combo, currentLoadout(owned))) return 0;
		const comboIds = new Set(combo.map((artifact) => artifact.instanceId));
		let waitMs = 0;
		for (const position of [
			1,
			2,
			3
		]) {
			const equipped = owned.find((artifact) => artifact.equippedPosition === position);
			if (equipped && comboIds.has(equipped.instanceId)) continue;
			waitMs = Math.max(waitMs, showroomCooldownRemainingMs(settings, position, {
				...slotLocks && { slotLocks },
				...typeof equipped?.slotLocked === "boolean" && { equippedSlotLocked: equipped.slotLocked },
				now
			}));
		}
		return waitMs;
	}
	function pinHorizonMs(siteState, now = Date.now()) {
		const untilReset = msUntilNextUtcMidnight(now);
		const event = siteState.communityEvent;
		if (!event?.isLive || !canEarnCommunityEventArp(event)) return untilReset;
		if (breakDownCommunityEventPending(event).waitingCommunityArp <= 0) return untilReset;
		const eta = estimateNextCommunityUnlock(event, now);
		if (eta === void 0 || eta.etaMs > 864e5) return untilReset;
		return Math.min(untilReset, eta.etaMs);
	}
	function pinnedEquippedArtifacts(owned, settings, siteState, slotLocks) {
		const horizonMs = pinHorizonMs(siteState);
		return owned.filter((artifact) => {
			if (artifact.equippedPosition === void 0) return false;
			if (!isShowroomSlotLocked(artifact.equippedPosition, {
				...slotLocks && { slotLocks },
				...typeof artifact.slotLocked === "boolean" && { equippedSlotLocked: artifact.slotLocked }
			})) return false;
			const remaining = showroomCooldownRemainingMs(settings, artifact.equippedPosition, {
				...slotLocks && { slotLocks },
				...typeof artifact.slotLocked === "boolean" && { equippedSlotLocked: artifact.slotLocked }
			});
			if (remaining > 0) return remaining >= horizonMs;
			return true;
		});
	}
	function combinationsWithPinned(owned, size, pinned) {
		if (pinned.length >= size) return [pinned.slice(0, size)];
		const pinnedIds = new Set(pinned.map((artifact) => artifact.instanceId));
		return combinations(owned.filter((artifact) => !pinnedIds.has(artifact.instanceId)), size - pinned.length).map((extra) => [...pinned, ...extra]);
	}
	function activeSets(familyIds) {
		return ARTIFACT_SETS.filter((set) => !set.unconfirmed && set.memberIds.every((id) => familyIds.includes(id)));
	}
	function resolveOwnedList(context) {
		const { snapshot, settings } = context;
		if (settings.preferScraped && snapshot.artifacts.length > 0) return snapshot.artifacts;
		if (settings.manualArtifacts.length > 0) return settings.manualArtifacts.map((manual, index) => {
			const family = getArtifactById(manual.familyId);
			const owned = {
				instanceId: manual.instanceId ?? -(index + 1),
				familyId: manual.familyId,
				displayName: family ? displayNameFor(family, manual.tier) : manual.familyId,
				tier: manual.tier,
				category: family?.category ?? "Weapon",
				maxLevel: manual.tier >= ArtifactTier.Interstellar,
				perkDescription: ""
			};
			const upgradeCost = fragmentCostToUpgradeFrom(manual.tier);
			if (upgradeCost !== void 0) owned.upgradeCost = upgradeCost;
			if (manual.equippedPosition !== void 0) owned.equippedPosition = manual.equippedPosition;
			return owned;
		});
		return snapshot.artifacts;
	}
	function currentLoadout(owned) {
		return owned.filter((artifact) => artifact.equippedPosition !== void 0).toSorted((left, right) => (left.equippedPosition ?? 0) - (right.equippedPosition ?? 0));
	}
	function isSameLoadout$1(left, right) {
		if (left.length !== right.length) return false;
		const rightIds = new Set(right.map((artifact) => artifact.instanceId));
		return left.every((artifact) => rightIds.has(artifact.instanceId));
	}
	function buildContext(snapshot, settings, siteState, nowMs) {
		const context = {
			snapshot,
			settings,
			siteState: siteState ?? emptySiteState()
		};
		if (nowMs !== void 0) context.nowMs = nowMs;
		return context;
	}
	function emptyBonuses() {
		return {
			steamQuests: 0,
			watchTwitch: 0,
			dailyCalendar: 0,
			timeOnSite: 0,
			discordPoll: 0,
			marketDiscountPct: 0,
			allArpPct: 0,
			communityPlaytimePct: 0
		};
	}
	function applyEffect(bonuses, type, value) {
		switch (type) {
			case ArtifactEffectType.SteamQuests:
				bonuses.steamQuests += value;
				break;
			case ArtifactEffectType.WatchTwitch:
				bonuses.watchTwitch += value;
				break;
			case ArtifactEffectType.DailyCalendar:
				bonuses.dailyCalendar += value;
				break;
			case ArtifactEffectType.TimeOnSite:
				bonuses.timeOnSite += value;
				break;
			case ArtifactEffectType.DiscordPoll:
				bonuses.discordPoll += value;
				break;
			case ArtifactEffectType.MarketDiscountPct:
				bonuses.marketDiscountPct += Math.abs(value);
				break;
			case ArtifactEffectType.AllArpPct:
				bonuses.allArpPct += value;
				break;
			case ArtifactEffectType.CommunityPlaytimePct: bonuses.communityPlaytimePct += value;
		}
	}
	function applySetBonuses(bonuses, familyIds) {
		for (const set of activeSets(familyIds)) {
			const arpEffects = set.effects.filter((effect) => effect.unit !== "cosmetic");
			for (const effect of arpEffects) applyEffect(bonuses, effect.type, effect.value);
		}
	}
	function collectBonuses(owned) {
		const bonuses = emptyBonuses();
		for (const item of owned) {
			const family = getArtifactById(item.familyId);
			if (!family) continue;
			applyEffect(bonuses, family.effectType, getNumericEffect(family, item.tier));
		}
		applySetBonuses(bonuses, owned.map((artifact) => artifact.familyId));
		return bonuses;
	}
	function activityStatsForArtifacts(artifacts) {
		const bonuses = collectBonuses(artifacts);
		return {
			allArpPct: bonuses.allArpPct,
			steamQuestsFlat: bonuses.steamQuests,
			watchTwitchFlat: bonuses.watchTwitch,
			dailyCalendarFlat: bonuses.dailyCalendar,
			discordPollFlat: bonuses.discordPoll,
			timeOnSiteFlat: bonuses.timeOnSite
		};
	}
	function setBreakdownParts(breakdown, key, base, categoryBonus = 0) {
		const value = base + categoryBonus;
		if (value === 0) return 0;
		breakdown[key] = {
			base,
			categoryBonus
		};
		return value;
	}
	function addDailyCategory(breakdown, key, base, flatBonus, days, frequency) {
		return setBreakdownParts(breakdown, key, base * days * frequency, flatBonus * days * frequency);
	}
	function isAllArpLockWorthBattlePassBoost(best, allArp, readyBoosts) {
		if (!best || !allArp || allArp.allArpPct <= 0 || readyBoosts <= 0) return false;
		const extraOnBoost = readyBoosts * 40 * (allArp.allArpPct - best.allArpPct);
		if (extraOnBoost <= 0) return false;
		return extraOnBoost > best.weeklyArp - allArp.weeklyArp;
	}
	function scoreSteamQuestBases(breakdown, bonuses, freq, bases) {
		if (bases.length === 0) return 0;
		return setBreakdownParts(breakdown, "steamQuests", bases.reduce((sum, base) => sum + base, 0) * freq, bonuses.steamQuests * bases.length * freq);
	}
	function scoreDailyQuests(breakdown, freq, dayStartsMs, now = Date.now()) {
		if (dayStartsMs.length === 0) return 0;
		const B = BASE_ACTIVITY;
		let dailyBase = 0;
		let weekendBase = 0;
		for (const startMs of dayStartsMs) {
			const onDay = new Date(now + startMs);
			dailyBase += B.dailyQuestBase * freq;
			if (onDay.getUTCDay() === 0 || onDay.getUTCDay() === 6) weekendBase += B.weekendQuestBase * freq;
		}
		let flatSum = setBreakdownParts(breakdown, "dailyQuests", dailyBase);
		if (weekendBase > 0) flatSum += setBreakdownParts(breakdown, "weekendQuests", weekendBase);
		return flatSum;
	}
	function scoreSecondaryActivities(breakdown, bonuses, context, isEnabled, freq, waitMs, now) {
		const { siteState } = context;
		const caps = siteState.caps;
		const B = BASE_ACTIVITY;
		let flatSum = 0;
		if (isEnabled("discordPoll") && isActivityPending(caps, "discordPoll")) {
			const polls = B.discordPollsWhenPending * freq("discordPoll");
			flatSum += setBreakdownParts(breakdown, "discordPoll", B.discordPollBase * polls, bonuses.discordPoll * polls);
		}
		if (isEnabled("dailyQuests")) {
			const questDays = completableUtcDayStarts(waitMs, 0, {
				todayAvailable: isActivityPending(caps, "dailyQuests"),
				now
			});
			flatSum += scoreDailyQuests(breakdown, freq("dailyQuests"), questDays, now);
		}
		if (isEnabled("steamCommunityEvent")) {
			const eventArp = communityEventArpInSwapWindow(siteState, waitMs);
			if (eventArp > 0) flatSum += setBreakdownParts(breakdown, "steamCommunityEvent", eventArp * freq("steamCommunityEvent"));
		}
		const readyClaims = battlePassClaimableArp(siteState.battlePass);
		if (readyClaims > 0 && !shouldDeferBattlePassForContext(context)) {
			if (!hasAllArpEffect(currentLoadout(resolveOwnedList(context))) || bonuses.allArpPct > 0) flatSum += setBreakdownParts(breakdown, "battlePassClaims", readyClaims * 40);
		}
		return flatSum;
	}
	function communityEventArpInSwapWindow(siteState, waitMs = 0) {
		const event = siteState.communityEvent;
		if (!event?.isLive || !canEarnCommunityEventArp(event)) return 0;
		let arp = breakDownCommunityEventPending(event).waitingPersonalArp;
		for (const milestone of event.milestones) {
			if (milestone.isAwarded || milestone.arpReward <= 0 || !isPersonalHoursMet(milestone, event.personalHours) || isCommunityGateMet(milestone, event.communityHours)) continue;
			const target = milestone.communityHoursRequired;
			if (target === void 0) continue;
			const eta = estimateCommunityUnlockAt(event, target);
			if (eta !== void 0 && eta.etaMs >= waitMs && eta.etaMs <= waitMs + 864e5) arp += milestone.arpReward;
		}
		return arp;
	}
	var TWITCH_MS_PER_ARP$1 = 6e4;
	var TIME_ON_SITE_DURATION_MS$2 = BASE_ACTIVITY.timeOnSiteBasePerDay * 6e4;
	function twitchArpInWearWindow(siteState, twitchFlat, waitMs, now) {
		const midnight = msUntilNextUtcMidnight(now);
		const todayRemaining = twitchWatchRemainingMs(siteState, twitchFlat) / 6e4;
		const fullDay = (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) + twitchFlat;
		let twitchArp = 0;
		if (todayRemaining > 0 && canCompleteInWearWindow(0, midnight, waitMs, todayRemaining * TWITCH_MS_PER_ARP$1)) twitchArp += todayRemaining;
		const laterDays = completableUtcDayStarts(waitMs, fullDay * TWITCH_MS_PER_ARP$1, {
			todayAvailable: false,
			now
		});
		for (const dayStart of laterDays) if (dayStart > 0) twitchArp += fullDay;
		return twitchArp;
	}
	function steamBasesInWearWindow(siteState, waitMs, now) {
		const mondayResetMs = msUntilNextSteamQuestWeek(now);
		const steamBases = [];
		const remaining = scrapedRemainingSteamQuestRewards(siteState);
		if (remaining && remaining.length > 0 && isActivityPending(siteState.caps, "steamQuests") && isWeeklyForcedIntoLock(mondayResetMs, waitMs)) steamBases.push(...remaining);
		if (isResetInWearWindow(mondayResetMs, waitMs)) steamBases.push(...BASE_ACTIVITY.steamQuestBases);
		return steamBases;
	}
	function scoreWindowActivities(bonuses, context, waitMs) {
		const { settings, siteState } = context;
		const now = resolveNow(context);
		const acts = settings.activities;
		const caps = siteState.caps;
		const B = BASE_ACTIVITY;
		const breakdown = {};
		let flatSum = 0;
		const isEnabled = (key) => (acts[key]?.enabled ?? false) && (acts[key]?.frequency ?? 0) > 0;
		const freq = (key) => isEnabled(key) ? acts[key]?.frequency ?? 0 : 0;
		if (isEnabled("timeOnSite")) {
			const tosDays = completableUtcDayStarts(waitMs, TIME_ON_SITE_DURATION_MS$2, {
				todayAvailable: isActivityAvailable(caps, "timeOnSite"),
				now
			});
			if (tosDays.length > 0) flatSum += addDailyCategory(breakdown, "timeOnSite", B.timeOnSiteBasePerDay, bonuses.timeOnSite, tosDays.length, freq("timeOnSite"));
		}
		if (isEnabled("watchTwitch")) {
			const twitchArp = twitchArpInWearWindow(siteState, bonuses.watchTwitch, waitMs, now);
			if (twitchArp > 0) flatSum += setBreakdownParts(breakdown, "watchTwitch", twitchArp);
		}
		if (isEnabled("steamQuests")) {
			const steamBases = steamBasesInWearWindow(siteState, waitMs, now);
			if (steamBases.length > 0) flatSum += scoreSteamQuestBases(breakdown, bonuses, freq("steamQuests"), steamBases);
		}
		if (isEnabled("dailyCalendar")) {
			const calendarDays = completableUtcDayStarts(waitMs, 0, {
				todayAvailable: false,
				now
			});
			if (calendarDays.length > 0) flatSum += addDailyCategory(breakdown, "dailyCalendar", B.dailyCalendarBasePerDay, bonuses.dailyCalendar, calendarDays.length, freq("dailyCalendar"));
		}
		flatSum += scoreSecondaryActivities(breakdown, bonuses, context, isEnabled, freq, waitMs, now);
		return {
			flatSum,
			breakdown
		};
	}
	function comboMarketDiscountPct(combo) {
		return combo?.marketDiscountPct ?? 0;
	}
	function projectedRedeemableArp(context, ...windows) {
		const current = context.siteState.arpLog?.redeemableArp;
		if (current === void 0) return;
		return current + Math.max(0, ...windows.map((combo) => combo?.weeklyArp ?? 0));
	}
	function vaultListPrice(context, discountPct = 0) {
		if (context.settings.pendingVaultPurchaseArp > 0) return context.settings.pendingVaultPurchaseArp;
		return gameVaultCatalogPrice(context.siteState, discountPct);
	}
	function vaultPurchasePriceNow(context, discountPct = 0) {
		if (!isGameVaultCurrentlyOpen(context.siteState, discountPct)) return 0;
		const price = vaultListPrice(context, discountPct);
		if (price <= 0) return 0;
		if (!canAffordVaultPrice(context.siteState.arpLog?.redeemableArp, vaultPayArp(price, discountPct))) return 0;
		return price;
	}
	function scoreCombo(three, context, waitMsOverride) {
		const bonuses = collectBonuses(three);
		const owned = resolveOwnedList(context);
		const now = resolveNow(context);
		const { flatSum, breakdown: rawBreakdown } = scoreWindowActivities(bonuses, context, waitMsOverride ?? comboEquipWaitMs(three, owned, context.settings, context.snapshot.slotLocks, now));
		const multiplier = 1 + bonuses.allArpPct;
		const windowArp = flatSum * multiplier;
		const breakdown = {};
		for (const [key, raw] of Object.entries(rawBreakdown)) {
			const preMultiplier = raw.base + raw.categoryBonus;
			const total = Math.round(preMultiplier * multiplier);
			const base = Math.round(raw.base);
			const categoryBonus = Math.round(raw.categoryBonus);
			breakdown[key] = {
				total,
				base,
				categoryBonus,
				allArpBonus: total - base - categoryBonus
			};
		}
		const marketplaceSavingsArp = vaultPurchasePriceNow(context, bonuses.marketDiscountPct) * bonuses.marketDiscountPct;
		return {
			artifacts: three,
			weeklyArp: Math.round(windowArp),
			marketplaceSavingsArp: Math.round(marketplaceSavingsArp),
			totalScore: Math.round(windowArp + marketplaceSavingsArp),
			allArpPct: bonuses.allArpPct,
			steamQuestsFlat: bonuses.steamQuests,
			watchTwitchFlat: bonuses.watchTwitch,
			dailyCalendarFlat: bonuses.dailyCalendar,
			discordPollFlat: bonuses.discordPoll,
			marketDiscountPct: bonuses.marketDiscountPct,
			activeSetNames: activeSets(three.map((a) => a.familyId)).map((s) => s.name),
			breakdown
		};
	}
	var BP_CLAIM_BUFFER_MS = 6e5;
	var deferBattlePassCache = new WeakMap();
	var UPGRADE_PATH_MAX = 5;
	function monthlyUpgradeGain(artifact, toTier) {
		const family = getArtifactById(artifact.familyId);
		if (!family || family.effectUnit === "cosmetic") return 0;
		const delta = getNumericEffect(family, toTier) - getNumericEffect(family, artifact.tier);
		if (delta <= 0) return 0;
		if (family.effectType === ArtifactEffectType.AllArpPct) return Math.round(delta * MONTHLY_ARP_FOR_PCT);
		const uses = MONTHLY_CATEGORY_USES[family.effectType];
		if (uses === void 0) return 0;
		return Math.round(delta * uses);
	}
	function withUpgradedArtifact(artifact, toTier) {
		const family = getArtifactById(artifact.familyId);
		const upgraded = {
			...artifact,
			tier: toTier,
			displayName: family ? displayNameFor(family, toTier) : artifact.displayName
		};
		const nextCost = fragmentCostToUpgradeFrom(toTier);
		if (nextCost === void 0) delete upgraded.upgradeCost;
		else upgraded.upgradeCost = nextCost;
		return upgraded;
	}
	function replaceOwned(owned, instanceId, replacement) {
		return owned.map((artifact) => artifact.instanceId === instanceId ? replacement : artifact);
	}
	function upgradeFocusRank(familyId, order) {
		const index = order.indexOf(familyId);
		return index === -1 ? order.length : index;
	}
	function nextUpgradeCandidate(owned, focusOrder) {
		const candidates = [];
		for (const artifact of owned) {
			if (artifact.tier >= ArtifactTier.Interstellar) continue;
			const family = getArtifactById(artifact.familyId);
			const toTier = artifact.tier + 1;
			if (family?.effects[toTier] === void 0) continue;
			const fragmentCost = artifact.upgradeCost ?? fragmentCostToUpgradeFrom(artifact.tier);
			if (fragmentCost === void 0) continue;
			const arpGain = monthlyUpgradeGain(artifact, toTier);
			if (arpGain <= 0) continue;
			candidates.push({
				artifact,
				fromTier: artifact.tier,
				toTier,
				fragmentCost,
				arpGain,
				efficiency: arpGain / fragmentCost,
				isAffordable: false
			});
		}
		return candidates.toSorted((left, right) => {
			const rankDelta = upgradeFocusRank(left.artifact.familyId, focusOrder) - upgradeFocusRank(right.artifact.familyId, focusOrder);
			if (rankDelta !== 0) return rankDelta;
			if (right.arpGain !== left.arpGain) return right.arpGain - left.arpGain;
			return left.fragmentCost - right.fragmentCost;
		})[0];
	}
	function suggestUpgrades(owned, fragments) {
		const focusOrder = upgradeFocusOrder(new Set(owned.map((artifact) => artifact.familyId)));
		let remaining = fragments;
		let isSaving = false;
		let working = owned.map((artifact) => ({ ...artifact }));
		const path = [];
		while (path.length < UPGRADE_PATH_MAX) {
			const next = nextUpgradeCandidate(working, focusOrder);
			if (!next) break;
			const isAffordable = !isSaving && next.fragmentCost <= remaining;
			if (isAffordable) remaining -= next.fragmentCost;
			else isSaving = true;
			const ownedName = owned.find((artifact) => artifact.instanceId === next.artifact.instanceId)?.displayName ?? next.artifact.displayName;
			path.push({
				...next,
				artifact: {
					...next.artifact,
					displayName: ownedName
				},
				isAffordable
			});
			working = replaceOwned(working, next.artifact.instanceId, withUpgradedArtifact(next.artifact, next.toTier));
		}
		return path;
	}
	function findBestCombo(owned, context) {
		if (resolveDeferredAllArp(owned, context)) {
			const equipped = currentLoadout(owned);
			const frozen = findBestComboBy(owned, context, (combo) => combo.weeklyArp, (combo) => combo.allArpPct > 0 || isSameLoadout$1(combo.artifacts, equipped));
			if (frozen) return frozen;
		}
		const best = findBestComboBy(owned, context, (combo) => combo.weeklyArp, () => true);
		const equipped = currentLoadout(owned);
		if (best && best.allArpPct > 0 && !isSameLoadout$1(best.artifacts, equipped)) {
			const waitMs = comboEquipWaitMs(best.artifacts, owned, context.settings, context.snapshot.slotLocks, resolveNow(context));
			if (waitMs > 0 && !isAllArpWorthTheLock(best.artifacts, owned, context, waitMs)) return findBestComboBy(owned, context, (combo) => combo.weeklyArp, (combo) => combo.allArpPct <= 0 || isSameLoadout$1(combo.artifacts, equipped));
		}
		return best;
	}
	function isAllArpWorthTheLock(allArpArtifacts, owned, context, waitMs) {
		const allArpBonuses = collectBonuses(allArpArtifacts);
		const alternative = bestFlatBonusesForLock(owned, context, waitMs);
		if (!alternative) return true;
		return communityEventArpInSwapWindow(context.siteState, waitMs) * allArpBonuses.allArpPct + forcedDailyArpDelta(context.siteState, waitMs, allArpBonuses, alternative, utcDailyEndBufferMs(context.settings), resolveNow(context)) > 0;
	}
	function bestFlatBonusesForLock(owned, context, waitMs) {
		const size = Math.min(3, owned.length);
		const pinned = pinnedEquippedArtifacts(owned, context.settings, context.siteState, context.snapshot.slotLocks);
		let best;
		let bestArp = Number.NEGATIVE_INFINITY;
		const consider = (combo) => {
			const bonuses = collectBonuses(combo);
			if (bonuses.allArpPct > 0) return;
			const scored = scoreCombo(combo, context, waitMs).weeklyArp;
			if (!best || scored > bestArp) {
				best = bonuses;
				bestArp = scored;
			}
		};
		for (const combo of combinationsWithPinned(owned, size, pinned)) consider(combo);
		const equipped = currentLoadout(owned);
		if (equipped.length > 0) consider(equipped);
		return best;
	}
	var MS_PER_DAY = 864e5;
	var TWITCH_MS_PER_ARP = 6e4;
	var TIME_ON_SITE_DURATION_MS$1 = BASE_ACTIVITY.timeOnSiteBasePerDay * 6e4;
	function utcDayBounds(dayStartMs, midnight) {
		if (dayStartMs <= 0) return {
			fromMs: 0,
			untilMs: midnight
		};
		return {
			fromMs: dayStartMs,
			untilMs: dayStartMs + MS_PER_DAY
		};
	}
	function isAutoClaimForcedIntoLock(dayStartMs, waitMs) {
		return dayStartMs > waitMs && dayStartMs <= waitMs + 864e5;
	}
	function isTimedDailyForcedIntoLock(dayStartMs, waitMs, durationMs, midnight, deadlineBufferMs) {
		const { fromMs, untilMs } = utcDayBounds(dayStartMs, midnight);
		return canCompleteInWearWindow(fromMs, untilMs, waitMs, durationMs) && !canCompleteOutsideWearWindow(fromMs, untilMs, waitMs, durationMs, 864e5, deadlineBufferMs);
	}
	function twitchDayArp(bonuses, siteState, isToday) {
		const cap = (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) + bonuses.watchTwitch;
		const remaining = twitchWatchRemainingMs(siteState, bonuses.watchTwitch) / 6e4;
		return (isToday ? remaining : cap) * (1 + bonuses.allArpPct);
	}
	function twitchDayDurationMs(bonuses, siteState, isToday) {
		const cap = (siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) + bonuses.watchTwitch;
		const remaining = twitchWatchRemainingMs(siteState, bonuses.watchTwitch) / 6e4;
		return (isToday ? remaining : cap) * TWITCH_MS_PER_ARP;
	}
	function forcedDailyArpDelta(siteState, waitMs, allArp, flat, deadlineBufferMs, now) {
		const midnight = msUntilNextUtcMidnight(now);
		let delta = 0;
		const twitchDays = [];
		if (twitchWatchRemainingMs(siteState, flat.watchTwitch) > 0) twitchDays.push(0);
		twitchDays.push(midnight, midnight + MS_PER_DAY);
		for (const dayStart of twitchDays) {
			if (dayStart > waitMs + 864e5) continue;
			const isToday = dayStart === 0;
			if (!isTimedDailyForcedIntoLock(dayStart, waitMs, twitchDayDurationMs(flat, siteState, isToday), midnight, deadlineBufferMs)) continue;
			delta += twitchDayArp(allArp, siteState, isToday) - twitchDayArp(flat, siteState, isToday);
		}
		const tosDays = [
			0,
			midnight,
			midnight + MS_PER_DAY
		].filter((dayStart) => (dayStart > 0 || isActivityAvailable(siteState.caps, "timeOnSite")) && isTimedDailyForcedIntoLock(dayStart, waitMs, TIME_ON_SITE_DURATION_MS$1, midnight, deadlineBufferMs));
		if (tosDays.length > 0) {
			const allArpTos = (BASE_ACTIVITY.timeOnSiteBasePerDay + allArp.timeOnSite) * (1 + allArp.allArpPct);
			const flatTos = (BASE_ACTIVITY.timeOnSiteBasePerDay + flat.timeOnSite) * (1 + flat.allArpPct);
			delta += tosDays.length * (allArpTos - flatTos);
		}
		const calendarDays = [midnight, midnight + MS_PER_DAY].filter((dayStart) => isAutoClaimForcedIntoLock(dayStart, waitMs));
		if (calendarDays.length > 0) {
			const allArpCal = (BASE_ACTIVITY.dailyCalendarBasePerDay + allArp.dailyCalendar) * (1 + allArp.allArpPct);
			const flatCal = (BASE_ACTIVITY.dailyCalendarBasePerDay + flat.dailyCalendar) * (1 + flat.allArpPct);
			delta += calendarDays.length * (allArpCal - flatCal);
		}
		const questDays = [
			0,
			midnight,
			midnight + MS_PER_DAY
		].filter((dayStart) => {
			const isTodayDue = dayStart === 0 && isActivityAvailable(siteState.caps, "dailyQuests");
			if (dayStart === 0 && !isTodayDue) return false;
			return isTimedDailyForcedIntoLock(dayStart, waitMs, 0, midnight, deadlineBufferMs);
		});
		for (const dayStart of questDays) {
			const onDay = new Date(now + dayStart);
			const weekend = onDay.getUTCDay() === 0 || onDay.getUTCDay() === 6 ? BASE_ACTIVITY.weekendQuestBase : 0;
			const base = BASE_ACTIVITY.dailyQuestBase + weekend;
			delta += base * (1 + allArp.allArpPct) - base * (1 + flat.allArpPct);
		}
		return delta;
	}
	function resolveDeferredAllArp(owned, context) {
		const event = context.siteState.communityEvent;
		if (!event?.isLive || !canEarnCommunityEventArp(event)) return;
		if (hasAllArpEffect(currentLoadout(owned))) return;
		const artifacts = unconstrainedAllArpCombo(owned);
		if (!artifacts) return;
		const waitMs = allArpEquipWaitMs(owned, context.settings, context.snapshot.slotLocks, resolveNow(context));
		if (waitMs === void 0 || waitMs <= 0) return;
		const waiting = waitingCommunityMilestones(event);
		const next = waiting[0];
		if (next === void 0) return;
		const nextTarget = next.communityHoursRequired;
		const nextEta = nextTarget === void 0 ? void 0 : estimateCommunityUnlockAt(event, nextTarget);
		const later = nextEta === void 0 || nextEta.etaMs < waitMs ? waiting.slice(1) : waiting;
		const firstLater = later[0];
		if (firstLater === void 0) return;
		const laterTarget = firstLater.communityHoursRequired;
		const laterEta = laterTarget === void 0 ? void 0 : estimateCommunityUnlockAt(event, laterTarget);
		const unlock = { arpReward: later.reduce((sum, milestone) => sum + milestone.arpReward, 0) };
		if (laterTarget !== void 0) unlock.targetHours = laterTarget;
		if (laterEta !== void 0) unlock.etaMs = laterEta.etaMs;
		if (!isAllArpWorthTheLock(artifacts, owned, context, waitMs)) return;
		return {
			waitMs,
			artifacts,
			unlock
		};
	}
	function resolveDeferredSteam(owned, context, best) {
		if (!isActivityPending(context.siteState.caps, "steamQuests")) return;
		const remaining = scrapedRemainingSteamQuestRewards(context.siteState);
		if (!remaining || remaining.length === 0) return;
		const steam = findBestSteamCombo(owned, context);
		if (!steam || steam.steamQuestsFlat <= 0) return;
		const equipped = currentLoadout(owned);
		if (isSameLoadout$1(steam.artifacts, equipped)) return;
		if (best && isSameLoadout$1(steam.artifacts, best.artifacts)) return;
		if (collectBonuses(equipped).steamQuests >= steam.steamQuestsFlat) return;
		const now = resolveNow(context);
		const waitMs = comboEquipWaitMs(steam.artifacts, owned, context.settings, context.snapshot.slotLocks, now);
		if (isWeeklyForcedIntoLock(msUntilNextSteamQuestWeek(now), waitMs)) return;
		return {
			waitMs,
			artifacts: steam.artifacts
		};
	}
	function comboTieBreakDelta(scored, best, equipped) {
		if (scored.allArpPct !== best.allArpPct) return scored.allArpPct - best.allArpPct;
		const isScoredEquipped = isSameLoadout$1(scored.artifacts, equipped);
		if (isScoredEquipped === isSameLoadout$1(best.artifacts, equipped)) return 0;
		return isScoredEquipped ? 1 : -1;
	}
	function findBestComboBy(owned, context, primary, isEligible) {
		if (owned.length === 0) return;
		const size = Math.min(3, owned.length);
		const equipped = currentLoadout(owned);
		const pinned = pinnedEquippedArtifacts(owned, context.settings, context.siteState, context.snapshot.slotLocks);
		let best;
		let bestPrimary = Number.NEGATIVE_INFINITY;
		for (const combo of combinationsWithPinned(owned, size, pinned)) {
			const scored = scoreCombo(combo, context);
			if (!isEligible(scored)) continue;
			const score = primary(scored);
			if (!best || score > bestPrimary || score === bestPrimary && scored.totalScore > best.totalScore || score === bestPrimary && scored.totalScore === best.totalScore && comboTieBreakDelta(scored, best, equipped) > 0) {
				best = scored;
				bestPrimary = score;
			}
		}
		return best;
	}
	function findBestAllArpCombo(owned, context) {
		return findBestComboBy(owned, context, (combo) => combo.allArpPct, (combo) => combo.allArpPct > 0);
	}
	function findBestSteamCombo(owned, context) {
		return findBestComboBy(owned, context, (combo) => combo.steamQuestsFlat, (combo) => combo.steamQuestsFlat > 0);
	}
	function findBestMarketDiscountCombo(owned, context) {
		return findBestComboBy(owned, context, (combo) => combo.marketDiscountPct, (combo) => combo.marketDiscountPct > 0);
	}
	function hasMarketDiscount(combo) {
		if (!combo || combo.artifacts.length === 0) return false;
		return combo.marketDiscountPct > 0;
	}
	function isMonthlyMetaEligible(artifact) {
		const family = getArtifactById(artifact.familyId);
		if (!family || family.effectUnit === "cosmetic") return false;
		if (family.effectType === ArtifactEffectType.None) return false;
		if (family.effectType === ArtifactEffectType.AllArpPct && getNumericEffect(family, artifact.tier) < 0) return false;
		return true;
	}
	function bestOwnedOfFamily(owned, familyId, usedIds) {
		return owned.filter((artifact) => artifact.familyId === familyId && !usedIds.has(artifact.instanceId) && isMonthlyMetaEligible(artifact)).toSorted((left, right) => right.tier - left.tier)[0];
	}
	function findMonthlyMetaCombo(owned, context) {
		const { standing, fillOrder } = monthlyMetaStandingFamilies(new Set(owned.map((artifact) => artifact.familyId)));
		const picked = [];
		const usedIds = new Set();
		const tryAddFamily = (familyId) => {
			if (picked.length >= 3) return;
			const artifact = bestOwnedOfFamily(owned, familyId, usedIds);
			if (!artifact) return;
			picked.push(artifact);
			usedIds.add(artifact.instanceId);
		};
		for (const familyId of standing) tryAddFamily(familyId);
		for (const familyId of fillOrder) tryAddFamily(familyId);
		if (picked.length === 0) return;
		return scoreCombo(picked, context);
	}
	function suggestDailySwap(best, current) {
		if (!current || current.artifacts.length < 3) return;
		const currentIds = new Set(current.artifacts.map((a) => a.instanceId));
		const bestIds = new Set(best.artifacts.map((a) => a.instanceId));
		const toUnequip = current.artifacts.find((a) => !bestIds.has(a.instanceId));
		const toEquip = best.artifacts.find((a) => !currentIds.has(a.instanceId));
		if (!toUnequip || !toEquip) return;
		return {
			unequip: toUnequip,
			equip: toEquip,
			reason: `Swap ${toUnequip.displayName} → ${toEquip.displayName} for +${best.totalScore - current.totalScore} estimated ARP in the next 24h swap window`
		};
	}
	function hasAllArpEffect(artifacts) {
		return collectBonuses(artifacts).allArpPct > 0;
	}
	function canAssembleAllArp(owned) {
		const ids = new Set(owned.map((artifact) => artifact.familyId));
		if (ids.has("herkow-plasma-chamber")) return true;
		return ARTIFACT_SETS.find((set) => set.id === "zorathian-renaissance")?.memberIds.every((id) => ids.has(id)) === true;
	}
	function hasInventoryAllArp(owned) {
		return canAssembleAllArp(owned) || hasAllArpEffect(owned);
	}
	function unconstrainedAllArpCombo(owned) {
		if (owned.length === 0) return;
		const size = Math.min(3, owned.length);
		let best;
		let bestPct = 0;
		for (const combo of combinations(owned, size)) {
			const pct = collectBonuses(combo).allArpPct;
			if (pct > bestPct) {
				bestPct = pct;
				best = combo;
			}
		}
		return bestPct > 0 ? best : void 0;
	}
	function allArpEquipWaitMs(owned, settings, slotLocks, now = Date.now()) {
		if (hasAllArpEffect(currentLoadout(owned))) return 0;
		const combo = unconstrainedAllArpCombo(owned);
		if (!combo) return;
		return comboEquipWaitMs(combo, owned, settings, slotLocks, now);
	}
	function shouldWaitForAllArpBeforeBattlePass(owned, settings, siteState, slotLocks) {
		if (!hasInventoryAllArp(owned)) return false;
		if (hasAllArpEffect(currentLoadout(owned))) return false;
		if (battlePassClaimableArp(siteState.battlePass) <= 0) return false;
		const waitMs = allArpEquipWaitMs(owned, settings, slotLocks);
		if (waitMs === void 0) return false;
		const bpLeft = battlePassRemainingMs(siteState.battlePass);
		if (bpLeft === void 0) return true;
		return waitMs + BP_CLAIM_BUFFER_MS < bpLeft;
	}
	function shouldDeferBattlePassForContext(context) {
		const cached = deferBattlePassCache.get(context);
		if (cached !== void 0) return cached;
		const shouldDefer = shouldWaitForAllArpBeforeBattlePass(resolveOwnedList(context), context.settings, context.siteState, context.snapshot.slotLocks);
		deferBattlePassCache.set(context, shouldDefer);
		return shouldDefer;
	}
	function appendBattlePassNotes(notes, owned, equipped, context) {
		const bp = context.siteState.battlePass;
		const readyArp = battlePassClaimableArp(bp);
		if (!bp || readyArp <= 0) return;
		const hasOwnedAllArp = hasInventoryAllArp(owned);
		const hasAllArpOn = hasAllArpEffect(equipped);
		if (hasOwnedAllArp && !hasAllArpOn) {
			if (shouldDeferBattlePassForContext(context)) return;
			notes.push(`Claim ${readyArp} Battle Pass ARP Boost(s) now — Battle Pass ends before All-ARP% can be equipped.`);
			return;
		}
		if (hasAllArpOn) {
			notes.push(`Claim ${readyArp} Battle Pass ARP Boost(s) now — All-ARP% is equipped.`);
			return;
		}
		notes.push(`You have ${readyArp} Battle Pass ARP Boost(s) ready to claim.`);
	}
	function appendCommunityEventNotes(notes, owned, equipped, context) {
		const event = context.siteState.communityEvent;
		if (!event?.isLive || !canEarnCommunityEventArp(event)) return;
		const breakdown = breakDownCommunityEventPending(event);
		if (breakdown.pendingCount <= 0 && nextLockedCommunityArpMilestone(event) === void 0) return;
		const summary = describeCommunityEventPendingNote(event, breakdown);
		const hasAllArpOwned = hasInventoryAllArp(owned);
		const hasAllArpOn = hasAllArpEffect(equipped);
		if (hasAllArpOwned && !hasAllArpOn && breakdown.waitingPersonalArp > 0) {
			notes.push(`${summary} — equip All-ARP% first.`);
			return;
		}
		if (hasAllArpOwned && !hasAllArpOn && communityEventArpInSwapWindow(context.siteState) > 0 && resolveDeferredAllArp(owned, context) === void 0) {
			notes.push(summary);
			return;
		}
		if (hasAllArpOwned && !hasAllArpOn && breakdown.waitingCommunityArp > 0) {
			const deferred = resolveDeferredAllArp(owned, context);
			if (deferred) {
				const hours = deferred.unlock.targetHours === void 0 ? "" : ` before ${deferred.unlock.targetHours.toLocaleString()}h`;
				notes.push(`${summary} — hold this loadout; All-ARP% in ${formatCommunityEta(deferred.waitMs)}${hours} (${formatCommunityEventArp(deferred.unlock.arpReward)}).`);
				return;
			}
			notes.push(`${summary} — consider All-ARP%.`);
			return;
		}
		notes.push(summary);
	}
	function describeCommunityEventPendingNote(event, breakdown) {
		if (breakdown.waitingPersonalArp > 0) return `${formatCommunityEventArp(breakdown.waitingPersonalArp)} unlocked by community`;
		if (breakdown.waitingCommunityArp > 0) return describeWaitingCommunityArpLine(event, breakdown.waitingCommunityArp);
		const nextLocked = nextLockedCommunityArpMilestone(event);
		if (nextLocked) return describeWaitingCommunityArpLine(event, nextLocked.arpReward);
		if (breakdown.imminentArp > 0) return `${formatCommunityEventArp(breakdown.imminentArp)} unlocked — not awarded yet`;
		return `${formatCommunityEventArp(event.pendingArp)} still open`;
	}
	function collectNotes(owned, equipped, best, context) {
		const notes = [];
		appendBattlePassNotes(notes, owned, equipped, context);
		appendCommunityEventNotes(notes, owned, equipped, context);
		if (isActivityPending(context.siteState.caps, "steamQuests") && equipped.length > 0) {
			const currentSteam = collectBonuses(equipped).steamQuests;
			const ownedSteam = Math.max(currentSteam, best?.steamQuestsFlat ?? 0, ...owned.map((artifact) => collectBonuses([artifact]).steamQuests));
			if (best && best.steamQuestsFlat < currentSteam) notes.push(`Steam Quests still look unfinished — finish them before swapping away from your +${currentSteam} Steam Quests bonus (equip before starting quests).`);
			else if (currentSteam === 0 && ownedSteam > 0) notes.push("Equip a Steam Quests artifact before starting any quest — Control Center still shows 15/25; real ARP is on the ARP Log.");
		}
		return notes;
	}
	function earliestSlotUnlockMs(context, now = Date.now()) {
		const slotLocks = context.snapshot.slotLocks;
		const remaining = [
			1,
			2,
			3
		].map((position) => {
			const equipped = context.snapshot.artifacts.find((artifact) => artifact.equippedPosition === position);
			return showroomCooldownRemainingMs(context.settings, position, {
				now,
				...slotLocks && { slotLocks },
				...typeof equipped?.slotLocked === "boolean" && { equippedSlotLocked: equipped.slotLocked }
			});
		});
		return now + Math.min(...remaining);
	}
	function dismissedVaultGuard(arpBest, cycleId) {
		return {
			best: arpBest,
			vaultDiscount: {
				cycleId,
				dismissed: true
			}
		};
	}
	function suggestVaultDiscount(best, discountCombo, note, cycleId) {
		const vaultDiscount = {
			cycleId,
			note,
			dismissed: false
		};
		if (discountCombo && !isSameLoadout$1(best.artifacts, discountCombo.artifacts)) return {
			best,
			marketDiscountLoadout: discountCombo,
			vaultDiscount
		};
		if (hasMarketDiscount(best)) return {
			best,
			vaultDiscount
		};
		return {
			best,
			vaultDiscount
		};
	}
	function resolvePreOpenVaultDiscount(arpBest, current, discountCombo, context, cycleId, now) {
		const opensAt = gameVaultOpensAtMs(context.siteState);
		if (opensAt === void 0) return { best: arpBest };
		const eta = formatCommunityEta(Math.max(0, opensAt - now));
		const swapAt = earliestSlotUnlockMs(context, now);
		if (current !== void 0 && isSameLoadout$1(arpBest.artifacts, current.artifacts)) {
			if (!willMissDiscountEquipBeforeOpen(swapAt, context.siteState, now)) return { best: arpBest };
			return {
				best: arpBest,
				vaultDiscount: {
					cycleId,
					dismissed: false,
					note: `Slots locked past Game Vault open (${eta}) — market-discount may not be equippable in time.`
				}
			};
		}
		if (!willMissDiscountEquipBeforeOpen(swapAt + 864e5, context.siteState, now)) return { best: arpBest };
		if (current && hasMarketDiscount(current)) return suggestVaultDiscount(current, discountCombo, `Keep market-discount equipped until Game Vault opens (${eta}) — swapping now would lock slots past open.`, cycleId);
		if (discountCombo) return suggestVaultDiscount(discountCombo, discountCombo, `Equip market-discount before Game Vault opens (${eta}) — a 24h ARP swap would still be locked at open.`, cycleId);
		return { best: arpBest };
	}
	function resolveOpenVaultDiscount(arpBest, current, discountCombo, context, cycleId, now) {
		if (current !== void 0 && isSameLoadout$1(arpBest.artifacts, current.artifacts)) {
			if (!discountCombo) return { best: arpBest };
			return {
				best: arpBest,
				marketDiscountLoadout: discountCombo,
				vaultDiscount: {
					cycleId,
					dismissed: false,
					note: "Game Vault has eligible claims — equip market-discount before buying (logout/relogin after)."
				}
			};
		}
		if (current && hasMarketDiscount(current)) return suggestVaultDiscount(current, discountCombo, "Keep market-discount equipped — Game Vault stock can run out, and a 24h swap would miss the discount.", cycleId);
		const canEquipNow = earliestSlotUnlockMs(context, now) <= now;
		if (discountCombo && canEquipNow) return suggestVaultDiscount(discountCombo, discountCombo, "Equip market-discount before claiming Game Vault (eligible stock can run out). Logout/relogin after.", cycleId);
		return {
			best: arpBest,
			vaultDiscount: {
				cycleId,
				dismissed: false,
				note: "Slots locked — Game Vault stock may run out before you can equip market-discount."
			}
		};
	}
	function resolveVaultDiscountBest(arpBest, current, discountCombo, context, now = Date.now()) {
		const cycleId = gameVaultCycleId(context.siteState);
		if (cycleId && context.settings.vaultDiscountDismissedCycle === cycleId) return dismissedVaultGuard(arpBest, cycleId);
		if (!arpBest || hasMarketDiscount(arpBest)) return { best: arpBest };
		const discountPct = comboMarketDiscountPct(discountCombo);
		const projectedArp = projectedRedeemableArp(context, arpBest, current, discountCombo);
		if (hasPostedListPriceVaultGames(context.siteState) && !canAffordAnyVaultOffer(context.siteState, discountPct, projectedArp)) return { best: arpBest };
		if (isGameVaultStockOpen(context.siteState)) return resolveOpenVaultDiscount(arpBest, current, discountCombo, context, cycleId ?? "open", now);
		const opensAt = gameVaultOpensAtMs(context.siteState);
		if (opensAt !== void 0 && opensAt > now) return resolvePreOpenVaultDiscount(arpBest, current, discountCombo, context, cycleId ?? context.siteState.gameVaultOpensAt ?? "upcoming", now);
		return { best: arpBest };
	}
	function optimize(context) {
		const owned = resolveOwnedList(context);
		if (owned.length === 0) return {
			best: void 0,
			current: void 0,
			alternatives: [],
			upgrades: [],
			dailySwap: void 0,
			notes: ["No owned artifacts known yet — inventory could not be loaded automatically. Open the optimizer again in a moment, or expand Advanced / manual overrides."],
			hasAllArpOwned: false,
			hasAllArpEquipped: false
		};
		const upgrades = suggestUpgrades(owned, context.settings.manualFragments ?? context.snapshot.fragments);
		const arpBest = findBestCombo(owned, context);
		const equipped = currentLoadout(owned);
		const current = equipped.length > 0 ? scoreCombo(equipped, context) : void 0;
		const allArpLoadout = findBestAllArpCombo(owned, context);
		const guarded = resolveVaultDiscountBest(arpBest, current, findBestMarketDiscountCombo(owned, context), context);
		const best = guarded.best;
		const monthlyMetaLoadout = findMonthlyMetaCombo(owned, context);
		const alternatives = [];
		if (owned.length >= 3) {
			const scored = combinationsWithPinned(owned, 3, pinnedEquippedArtifacts(owned, context.settings, context.siteState, context.snapshot.slotLocks)).map((combo) => scoreCombo(combo, context)).toSorted((left, right) => right.weeklyArp - left.weeklyArp);
			alternatives.push(...scored.slice(0, 5));
		}
		const marketDiscountLoadout = guarded.marketDiscountLoadout;
		if (marketDiscountLoadout && alternatives.every((combo) => !isSameLoadout$1(combo.artifacts, marketDiscountLoadout.artifacts))) alternatives.push(marketDiscountLoadout);
		const deferredAllArp = resolveDeferredAllArp(owned, context);
		const deferredSteam = resolveDeferredSteam(owned, context, best);
		const shouldDeferBattlePassClaims = shouldDeferBattlePassForContext(context);
		const isDedicatedLockWorthIt = isAllArpLockWorthBattlePassBoost(best, allArpLoadout, battlePassClaimableArp(context.siteState.battlePass));
		const notes = collectNotes(owned, equipped, best, context);
		const result = {
			best,
			current,
			alternatives,
			upgrades,
			dailySwap: best ? suggestDailySwap(best, current) : void 0,
			notes,
			hasAllArpOwned: hasInventoryAllArp(owned),
			hasAllArpEquipped: hasAllArpEffect(equipped),
			deferBattlePassClaims: shouldDeferBattlePassClaims
		};
		if (isDedicatedLockWorthIt) result.worthDedicatedAllArpForBattlePass = true;
		if (context.snapshot.slotLocks) result.slotLocks = context.snapshot.slotLocks;
		if (allArpLoadout) result.allArpLoadout = allArpLoadout;
		if (deferredAllArp) result.deferredAllArp = deferredAllArp;
		if (deferredSteam) result.deferredSteam = deferredSteam;
		if (marketDiscountLoadout) result.marketDiscountLoadout = marketDiscountLoadout;
		if (monthlyMetaLoadout) result.monthlyMetaLoadout = monthlyMetaLoadout;
		if (guarded.vaultDiscount) result.vaultDiscount = guarded.vaultDiscount;
		return result;
	}
	function formatMs(ms) {
		const days = Math.floor(ms / 864e5);
		const hours = Math.floor(ms % 864e5 / 36e5);
		if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
		const mins = Math.floor(ms % 36e5 / 6e4);
		if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
		if (hours > 0) return `${hours}h`;
		if (mins > 0) return `${mins}m`;
		return "<1m";
	}
	function msUntilUtcMidnight(now = new Date()) {
		const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
		return Math.max(0, next - now.getTime());
	}
	function utcResetDeadlineLabel(now = new Date()) {
		return `${formatMs(msUntilUtcMidnight(now))} left`;
	}
	function sortArtifactsForDisplay(artifacts) {
		return artifacts.toSorted((left, right) => left.displayName.localeCompare(right.displayName, void 0, { sensitivity: "base" }));
	}
	function loadoutLabel(artifacts) {
		if (!artifacts || artifacts.length === 0) return "—";
		return sortArtifactsForDisplay(artifacts).map((artifact) => artifact.displayName).join(" + ");
	}
	function loadoutSetNames(artifacts) {
		if (!artifacts || artifacts.length === 0) return [];
		return activeSets(artifacts.map((artifact) => artifact.familyId)).map((set) => set.name);
	}
	function comboLabel(result) {
		if (!result) return "—";
		return loadoutLabel(result.artifacts);
	}
	function isSameLoadout(left, right) {
		if (!left || !right || left.length === 0 || right.length === 0) return false;
		const leftIds = new Set(left.map((artifact) => artifact.instanceId));
		const rightIds = new Set(right.map((artifact) => artifact.instanceId));
		return leftIds.size === rightIds.size && [...leftIds].every((id) => rightIds.has(id));
	}
	function maxSlotCooldownMs(settings, current, slotLocks) {
		return Math.max(0, ...[
			1,
			2,
			3
		].map((position) => {
			const equippedSlotLocked = current?.artifacts.find((artifact) => artifact.equippedPosition === position)?.slotLocked;
			return showroomCooldownRemainingMs(settings, position, {
				...slotLocks && { slotLocks },
				...typeof equippedSlotLocked === "boolean" && { equippedSlotLocked }
			});
		}));
	}
	function formatLockedSlotParts(settings, lockedSlots, slotLocks) {
		return lockedSlots.map((position) => {
			const remaining = showroomCooldownRemainingMs(settings, position, { ...slotLocks && { slotLocks } });
			const estimateTag = settings.slotCooldowns.find((slot) => slot.position === position)?.estimated === true ? ", estimated" : "";
			if (remaining <= 0) return `slot ${position} (locked${estimateTag})`;
			return `slot ${position} (${formatMs(remaining)} left${estimateTag})`;
		});
	}
	function hasAnySlotOnCooldown(current, slotLocks) {
		return [
			1,
			2,
			3
		].some((position) => isSlotLockedForEquip(current, position, slotLocks));
	}
	function isSlotLockedForEquip(current, position, slotLocks) {
		const equipped = current?.artifacts.find((artifact) => artifact.equippedPosition === position);
		return isShowroomSlotLocked(position, {
			...slotLocks && { slotLocks },
			...typeof equipped?.slotLocked === "boolean" && { equippedSlotLocked: equipped.slotLocked }
		});
	}
	function loadoutMonthlyScore(artifacts) {
		const bonuses = collectBonuses(artifacts);
		return bonuses.allArpPct * MONTHLY_ARP_FOR_PCT + bonuses.steamQuests * (MONTHLY_CATEGORY_USES[ArtifactEffectType.SteamQuests] ?? 0) + bonuses.watchTwitch * (MONTHLY_CATEGORY_USES[ArtifactEffectType.WatchTwitch] ?? 0) + bonuses.dailyCalendar * (MONTHLY_CATEGORY_USES[ArtifactEffectType.DailyCalendar] ?? 0) + bonuses.timeOnSite * (MONTHLY_CATEGORY_USES[ArtifactEffectType.TimeOnSite] ?? 0) + bonuses.discordPoll * (MONTHLY_CATEGORY_USES[ArtifactEffectType.DiscordPoll] ?? 0) + bonuses.marketDiscountPct * 1e3 + bonuses.communityPlaytimePct * 200;
	}
	function marginalEquipScore(artifact, basis) {
		return loadoutMonthlyScore([...basis, artifact]) - loadoutMonthlyScore(basis);
	}
	function compareByName(left, right) {
		return left.displayName.localeCompare(right.displayName, void 0, { sensitivity: "base" });
	}
	function sortByMarginalEquipPriority(pieces, basis) {
		return pieces.toSorted((left, right) => {
			const scoreDelta = marginalEquipScore(right, basis) - marginalEquipScore(left, basis);
			if (scoreDelta !== 0) return scoreDelta;
			return compareByName(left, right);
		});
	}
	function pickImmediateEquips(kept, remaining, slotCount) {
		const fillCount = Math.min(slotCount, remaining.length);
		if (fillCount <= 0) return [];
		let bestSubset = [];
		let bestScore = Number.NEGATIVE_INFINITY;
		for (const subset of combinations(remaining, fillCount)) {
			const score = loadoutMonthlyScore([...kept, ...subset]);
			if (score < bestScore) continue;
			if (score > bestScore) {
				bestScore = score;
				bestSubset = subset;
				continue;
			}
			const bestKey = bestSubset.map((item) => item.displayName).join("|");
			if (subset.map((item) => item.displayName).join("|").localeCompare(bestKey) < 0) bestSubset = subset;
		}
		const ordered = [];
		const pool = [...bestSubset];
		const basis = [...kept];
		while (pool.length > 0) {
			pool.sort((left, right) => {
				const scoreDelta = marginalEquipScore(right, basis) - marginalEquipScore(left, basis);
				if (scoreDelta !== 0) return scoreDelta;
				return compareByName(left, right);
			});
			const next = pool.shift();
			if (!next) break;
			ordered.push(next);
			basis.push(next);
		}
		return ordered;
	}
	function planLoadoutChanges(combo, current, settings, slotLocks) {
		const slots = [
			1,
			2,
			3
		];
		const lockedSlots = slots.filter((position) => isSlotLockedForEquip(current, position, slotLocks));
		const currentBySlot = new Map();
		const equippedArtifacts = current?.artifacts ?? [];
		for (const artifact of equippedArtifacts) if (artifact.equippedPosition !== void 0) currentBySlot.set(artifact.equippedPosition, artifact);
		const comboIds = new Set(combo.map((artifact) => artifact.instanceId));
		const placedIds = new Set();
		const reservedSlots = new Set();
		const keptSlots = new Set();
		const kept = [];
		for (const position of slots) {
			const equipped = currentBySlot.get(position);
			if (equipped && comboIds.has(equipped.instanceId)) {
				placedIds.add(equipped.instanceId);
				reservedSlots.add(position);
				keptSlots.add(position);
				kept.push(equipped);
				continue;
			}
			if (lockedSlots.includes(position)) reservedSlots.add(position);
		}
		const remaining = combo.filter((artifact) => !placedIds.has(artifact.instanceId));
		const freeSlots = slots.filter((position) => !reservedSlots.has(position) && !lockedSlots.includes(position));
		const nowArtifacts = pickImmediateEquips(kept, remaining, freeSlots.length);
		const now = [];
		for (const artifact of nowArtifacts) {
			const position = freeSlots.shift();
			if (position === void 0) break;
			const replaced = currentBySlot.get(position);
			now.push({
				artifactId: artifact.instanceId,
				position,
				displayName: artifact.displayName,
				...replaced && { replacedDisplayName: replaced.displayName }
			});
			placedIds.add(artifact.instanceId);
		}
		const laterBasis = [...kept, ...nowArtifacts];
		const later = sortByMarginalEquipPriority(combo.filter((artifact) => !placedIds.has(artifact.instanceId)), laterBasis).map((artifact) => ({
			artifactId: artifact.instanceId,
			displayName: artifact.displayName
		}));
		const waitMs = Math.max(0, ...lockedSlots.filter((position) => later.length === 0 || !keptSlots.has(position)).map((position) => {
			const equippedSlotLocked = currentBySlot.get(position)?.slotLocked;
			return showroomCooldownRemainingMs(settings, position, {
				...slotLocks && { slotLocks },
				...typeof equippedSlotLocked === "boolean" && { equippedSlotLocked }
			});
		}));
		return {
			now,
			later,
			laterNames: later.map((item) => item.displayName),
			lockedSlots,
			waitMs
		};
	}
	function artifactsAfterImmediateEquip(current, best, plan) {
		const bySlot = new Map();
		const equipped = current?.artifacts ?? [];
		for (const artifact of equipped) if (artifact.equippedPosition !== void 0) bySlot.set(artifact.equippedPosition, artifact);
		for (const change of plan.now) {
			const incoming = best.artifacts.find((artifact) => artifact.instanceId === change.artifactId);
			if (!incoming) continue;
			bySlot.set(change.position, {
				...incoming,
				equippedPosition: change.position
			});
		}
		return bySlot.values().toArray();
	}
	function escapeHtml(value) {
		return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
	}
	var MODAL_ID = "alienware-artifact-optimizer";
	var INLINE_ID = "alienware-artifact-optimizer-inline";
	var CC_PANEL_ID = "alienware-artifact-optimizer-cc";
	var BP_CLAIM_BAR_ID = "alienware-artifact-optimizer-bp-claim";
	var STYLE_ID$1 = "alienware-artifact-optimizer-styles";
	var BACKDROP_ID = "alienware-artifact-optimizer-backdrop";
	var DIALOG_ID = "alienware-artifact-optimizer-dialog";
	var TOAST_ID = "alienware-artifact-optimizer-toast";
	var ARTIFACT_TIP_ID = "ao-artifact-tip-float";
	var TOAST_MS = 2200;
	var MODAL_LAYOUT = [
		["position", "fixed"],
		["top", "50%"],
		["left", "50%"],
		["transform", "translate(-50%, -50%)"],
		["z-index", "10001"],
		["width", "min(560px, 94vw)"],
		["max-height", "90vh"],
		["overflow-y", "auto"]
	];
	var BACKDROP_LAYOUT = [
		["position", "fixed"],
		["inset", "0"],
		["background", "rgba(0, 0, 0, 0.85)"],
		["z-index", "10000"]
	];
	function cssDeclarations(layout) {
		return layout.map(([property, value]) => `${property}: ${value};`).join("\n        ");
	}
	function buildOptimizerCss() {
		return `
      #${BACKDROP_ID} {
        display: none;
        ${cssDeclarations(BACKDROP_LAYOUT)}
      }
      #${MODAL_ID} {
        display: none;
        ${cssDeclarations(MODAL_LAYOUT)}
        background: transparent;
      }
      #${INLINE_ID},
      #${CC_PANEL_ID} {
        display: block;
        margin: 16px 0;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
      }
      body > #${INLINE_ID},
      body > #${CC_PANEL_ID},
      html > #${INLINE_ID},
      html > #${CC_PANEL_ID} {
        margin: 88px auto 16px;
        padding: 0 16px;
        max-width: 1100px;
      }
      #${DIALOG_ID} {
        position: fixed;
        inset: 0;
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #${DIALOG_ID}[hidden] {
        display: none !important;
      }
      #${DIALOG_ID} .ao-dialog-scrim {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.85);
      }
      #${DIALOG_ID} .ao-dialog {
        position: relative;
        z-index: 1;
        width: min(420px, 92vw);
        background: #1a1a1a;
        color: #fff;
        border: 1px solid #00bc8c;
        border-radius: 8px;
        padding: 20px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.85);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
        line-height: 1.45;
      }
      #${DIALOG_ID} .ao-dialog-title {
        margin: 0 0 10px;
        color: #00bc8c;
        font-size: 1.1em;
        font-weight: bold;
      }
      #${DIALOG_ID} .ao-dialog-message {
        margin: 0 0 16px;
        color: #eee;
        white-space: pre-wrap;
      }
      #${DIALOG_ID} .ao-dialog-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: flex-end;
      }
      #${DIALOG_ID} button {
        background: #00bc8c;
        color: #fff;
        border: none;
        padding: 6px 12px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      }
      #${DIALOG_ID} button.ao-secondary {
        background: #555;
      }
      #${DIALOG_ID} button.ao-danger {
        background: #e74c3c;
      }
      #${TOAST_ID} {
        position: fixed;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10003;
        max-width: min(420px, 92vw);
        background: #1a1a1a;
        color: #fff;
        border: 1px solid #00bc8c;
        border-radius: 8px;
        padding: 10px 16px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 14px;
      }
      #${TOAST_ID}[hidden] {
        display: none !important;
      }
      #${ARTIFACT_TIP_ID} {
        position: fixed;
        z-index: 10004;
        max-width: min(280px, 92vw);
        background: #1a1a1a;
        color: #fff;
        border: 1px solid #00bc8c;
        border-radius: 8px;
        padding: 10px 12px;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        pointer-events: none;
      }
      #${ARTIFACT_TIP_ID}[hidden] {
        display: none !important;
      }
      #${ARTIFACT_TIP_ID} .ao-artifact-tip-name {
        color: #00bc8c;
        font-weight: 700;
        margin: 0 0 4px;
      }
      #${ARTIFACT_TIP_ID} .ao-artifact-tip-meta {
        color: #aaa;
        font-size: 0.92em;
        margin: 0 0 6px;
      }
      #${ARTIFACT_TIP_ID} .ao-artifact-tip-effect {
        color: #fff;
        font-weight: 600;
      }
      #${ARTIFACT_TIP_ID} .ao-artifact-tip-detail,
      #${ARTIFACT_TIP_ID} .ao-artifact-tip-set {
        color: #ccc;
        font-size: 0.92em;
        margin-top: 4px;
      }
  `;
	}
	function ensureOptimizerStyles() {
		let style = document.querySelector(`#${STYLE_ID$1}`);
		if (!style) {
			style = document.createElement("style");
			style.id = STYLE_ID$1;
			(document.head || document.documentElement).append(style);
		}
		style.textContent = buildOptimizerCss();
	}
	function applyOpaqueModalChrome(modal) {
		const paint = [
			...MODAL_LAYOUT,
			["background", "transparent"],
			["opacity", "1"]
		];
		for (const [property, value] of paint) modal.style.setProperty(property, value, "important");
	}
	function applyOpaqueBackdropChrome(backdrop) {
		const paint = [
			...BACKDROP_LAYOUT,
			["background-color", "rgba(0, 0, 0, 0.85)"],
			["opacity", "1"]
		];
		for (const [property, value] of paint) backdrop.style.setProperty(property, value, "important");
	}
	function buildPanelShadowCss(variant) {
		return `
    ${variant === "modal" ? `
    :host {
      display: none;
      ${cssDeclarations(MODAL_LAYOUT)}
      box-sizing: border-box;
    }
  ` : `
    :host {
      display: block;
      margin: 0;
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
    }
  `}
    .ao-panel,
    .ao-panel * {
      text-decoration: none !important;
      text-decoration-line: none !important;
      -webkit-text-fill-color: unset !important;
      text-transform: none !important;
      letter-spacing: normal !important;
      text-shadow: none !important;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif !important;
      box-sizing: border-box;
    }
    .ao-panel {
      display: block;
      background: #1a1a1a;
      color: #fff;
      padding: ${variant === "modal" ? "20px" : "16px"};
      border-radius: 8px;
      border: 1px solid ${variant === "modal" ? "#444" : "#00bc8c"};
      box-shadow: ${variant === "modal" ? "0 12px 40px rgba(0, 0, 0, 0.85)" : "0 0 10px rgba(0, 188, 140, 0.25)"};
      font-size: 14px;
      line-height: 1.4;
      width: 100%;
    }
    .ao-panel > * {
      display: block;
      width: 100%;
    }
    .ao-title {
      color: #fff !important;
      font-size: 1.4em !important;
      font-weight: bold !important;
      margin: 0 0 12px !important;
    }
    .ao-heading {
      color: #00bc8c !important;
      font-size: 1.05em !important;
      font-weight: bold !important;
      margin: 14px 0 8px !important;
    }
    .ao-heading:first-child {
      margin-top: 0 !important;
    }
    .ao-row {
      display: block;
      margin: 6px 0 6px 8px;
      color: #fff !important;
      line-height: 1.4;
    }
    .ao-panel .ao-artifact-tip {
      border-bottom: 1px dotted #00bc8c;
      cursor: help;
    }
    .ao-muted {
      color: #aaa !important;
      font-size: 0.9em !important;
    }
    .ao-credit {
      margin: 0 0 10px !important;
    }
    .ao-note {
      display: block;
      background: #2a2a2a;
      border-left: 3px solid #00bc8c;
      padding: 8px 10px;
      margin: 8px 0;
      color: #eee !important;
    }
    .ao-note > div + div {
      margin-top: 4px;
    }
    .ao-note-actions {
      margin-top: 8px;
    }
    .ao-status-details {
      margin: 8px 0 4px;
    }
    .ao-status-details summary {
      cursor: pointer;
      user-select: none;
    }
    .ao-status-details[open] summary {
      margin-bottom: 6px;
    }
    .ao-text-link {
      color: #00bc8c !important;
      text-decoration: underline !important;
      text-decoration-line: underline !important;
      cursor: pointer;
    }
    .ao-actions {
      display: flex !important;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
      width: 100%;
    }
    .ao-actions-sep {
      width: 1px;
      align-self: stretch;
      min-height: 28px;
      background: #555;
      margin: 0 4px;
    }
    .ao-todo-list {
      display: block;
      margin: 0 0 4px;
      padding: 0;
      list-style: none;
      width: 100%;
    }
    .ao-divider {
      display: block;
      border: 0;
      border-top: 1px solid #444;
      margin: 14px 0;
      width: 100%;
    }
    .ao-todo-item {
      display: flex;
      gap: 6px;
      margin: 6px 0;
      line-height: 1.45;
      color: #eee !important;
      align-items: flex-start;
    }
    .ao-todo-index {
      color: #00bc8c !important;
      font-weight: 600;
      flex: 0 0 auto;
      padding-top: 1px;
    }
    .ao-todo-item > .ao-upgrade-btn,
    .ao-todo-item > .ao-claim-btn,
    .ao-todo-item > .ao-twitch-btn {
      flex: 0 0 auto;
      padding: 4px 10px;
      font-size: 13px !important;
    }
    .ao-row .ao-upgrade-btn {
      margin-left: 8px;
    }
    .ao-todo-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .ao-todo-headline {
      display: block;
      font-weight: 600;
    }
    .ao-todo-loadout {
      display: block;
      color: #fff !important;
      margin: 2px 0 2px;
    }
    .ao-todo-reasons {
      display: block;
      margin: 4px 0 0;
      padding: 0 0 0 1.1em;
      list-style: disc;
      color: #ccc !important;
    }
    .ao-todo-reasons > li {
      display: list-item;
      margin: 2px 0;
    }
    .ao-todo-reason-text {
      display: block;
    }
    .ao-todo-reason-detail {
      display: block;
      margin-top: 1px;
      color: #aaa !important;
      font-size: 0.92em;
    }
    .ao-todo-muted {
      color: #aaa !important;
    }
    .ao-todo-warn {
      color: #f0c674 !important;
    }
    .ao-caution {
      display: block;
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid #f0c674;
      border-radius: 6px;
      background: rgba(240, 198, 116, 0.12);
      color: #f0c674 !important;
    }
    .ao-caution .ao-todo-headline {
      font-weight: 700;
    }
    .ao-caution .ao-todo-reasons {
      color: #e6d5a3 !important;
      padding-left: 1.1em;
    }
    button {
      display: inline-block;
      width: auto;
      background: #00bc8c;
      color: #fff !important;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px !important;
    }
    button[hidden] {
      display: none !important;
    }
    button.ao-secondary {
      background: #555;
    }
    button.ao-loadout-preview {
      white-space: normal;
      text-align: left;
      max-width: 100%;
    }
    button.ao-danger {
      background: #e74c3c;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    label.ao-toggle {
      display: block;
      margin: 4px 0 4px 8px;
      color: #fff !important;
    }
    input[type="number"],
    input[type="text"],
    select,
    textarea.ao-textarea {
      width: 90px;
      margin-left: 6px;
      padding: 2px 4px;
      background: #2a2a2a;
      color: #fff !important;
      border: 1px solid #555;
      border-radius: 3px;
      caret-color: #fff;
      font-size: 14px !important;
    }
    textarea.ao-textarea {
      display: block;
      width: calc(100% - 8px);
      min-height: 72px;
      margin: 6px 0 6px 8px;
      resize: vertical;
    }
    select {
      width: auto;
      min-width: 120px;
    }
    input[type="checkbox"] {
      margin-right: 6px;
      accent-color: #00bc8c;
    }
    .ao-notify {
      display: block;
      margin: 0 0 12px;
      padding: 10px 12px;
      background: #222;
      border: 1px solid #333;
      border-radius: 8px;
    }
    .ao-switch {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      margin: 0;
      cursor: pointer;
      color: #fff !important;
    }
    .ao-switch-copy {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .ao-switch-title {
      font-weight: 600;
      color: #fff !important;
    }
    .ao-switch-hint {
      color: #aaa !important;
      font-size: 0.88em !important;
      line-height: 1.4;
    }
    .ao-switch-input {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .ao-switch-track {
      position: relative;
      flex: 0 0 auto;
      width: 44px;
      height: 24px;
      border-radius: 999px;
      background: #3a3a3a;
      box-shadow: inset 0 0 0 1px #555;
      transition: background 0.16s ease, box-shadow 0.16s ease;
    }
    .ao-switch-knob {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
      transition: transform 0.16s ease;
    }
    .ao-switch-input:checked + .ao-switch-track {
      background: #00bc8c;
      box-shadow: inset 0 0 0 1px #00bc8c;
    }
    .ao-switch-input:checked + .ao-switch-track .ao-switch-knob {
      transform: translateX(20px);
    }
    .ao-switch-input:focus-visible + .ao-switch-track {
      outline: 2px solid #00bc8c;
      outline-offset: 3px;
    }
    .ao-notify-types {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #333;
    }
    .ao-notify-types[data-off] {
      opacity: 0.45;
      pointer-events: none;
    }
    .ao-switch-sm .ao-switch-title {
      font-weight: 500;
      font-size: 0.92em !important;
    }
    .ao-switch-sm .ao-switch-hint {
      font-size: 0.8em !important;
    }
    .ao-switch-sm .ao-switch-track {
      width: 36px;
      height: 20px;
    }
    .ao-switch-sm .ao-switch-knob {
      width: 16px;
      height: 16px;
    }
    .ao-switch-sm .ao-switch-input:checked + .ao-switch-track .ao-switch-knob {
      transform: translateX(16px);
    }
    details {
      display: block;
      width: 100%;
    }
    details.ao-advanced {
      margin-top: 14px;
      border-top: 1px solid #333;
      padding-top: 10px;
    }
    details.ao-advanced > summary {
      cursor: pointer;
      color: #00bc8c !important;
      font-weight: bold;
      list-style: none;
    }
    details.ao-advanced > summary::-webkit-details-marker {
      display: none;
    }
    details.ao-advanced > summary::before {
      content: '▸ ';
    }
    details.ao-advanced[open] > summary::before {
      content: '▾ ';
    }
    details > summary {
      color: #aaa !important;
      cursor: pointer;
    }
    .ao-hydrate {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
      padding: 8px 10px;
      background: #222;
      border: 1px solid #00bc8c55;
      border-radius: 4px;
      color: #ccc !important;
      font-size: 0.92em !important;
    }
    .ao-spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #00bc8c44;
      border-top-color: #00bc8c;
      border-radius: 50%;
      animation: ao-spin 0.7s linear infinite;
      flex: 0 0 auto;
    }
    .ao-skel {
      display: block;
      height: 12px;
      margin: 8px 0;
      border-radius: 4px;
      background: linear-gradient(90deg, #2a2a2a 25%, #333 37%, #2a2a2a 63%);
      background-size: 400% 100%;
      animation: ao-skel 1.2s ease-in-out infinite;
    }
    @keyframes ao-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes ao-skel {
      0% {
        background-position: 100% 0;
      }
      100% {
        background-position: 0 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ao-spinner,
      .ao-skel {
        animation: none;
      }
      .ao-switch-track,
      .ao-switch-knob {
        transition: none;
      }
    }
  `;
	}
	function buildModalShadowCss() {
		return buildPanelShadowCss("modal");
	}
	function buildInlineShadowCss() {
		return buildPanelShadowCss("inline");
	}
	function formatSigned(value) {
		return value < 0 ? `−${Math.abs(value)}` : `+${value}`;
	}
	function formatPct(value) {
		const pct = value * 100;
		const abs = Math.abs(pct);
		const rounded = Number.isSafeInteger(abs) ? String(abs) : abs.toFixed(1);
		return `${pct < 0 ? "−" : "+"}${rounded}%`;
	}
	function describeNumericEffect(type, value) {
		switch (type) {
			case ArtifactEffectType.SteamQuests: return { effect: `${formatSigned(value)} Steam Quests ARP` };
			case ArtifactEffectType.WatchTwitch: {
				const cap = BASE_ACTIVITY.watchTwitchBasePerDay + value;
				return {
					effect: `${formatSigned(value)} Watch Twitch ARP`,
					detail: `Raises the daily Twitch cap to ${cap} (1 ARP/min).`
				};
			}
			case ArtifactEffectType.DailyCalendar: return { effect: `${formatSigned(value)} Daily Calendar ARP` };
			case ArtifactEffectType.TimeOnSite: return { effect: `${formatSigned(value)} Time on Site ARP` };
			case ArtifactEffectType.DiscordPoll: return { effect: `${formatSigned(value)} Discord Poll ARP` };
			case ArtifactEffectType.MarketDiscountPct: return { effect: `${Math.round(Math.abs(value) * 100)}% Game Vault / marketplace discount` };
			case ArtifactEffectType.AllArpPct: return {
				effect: `${formatPct(value)} All ARP`,
				detail: value > 0 ? "Multiplies ARP from activities and claims while equipped." : "Reduces All ARP while this is equipped."
			};
			case ArtifactEffectType.CommunityPlaytimePct: return { effect: `${formatPct(value)} Community Event playtime` };
			default: return { effect: "No ARP bonus" };
		}
	}
	function describeDefinitionEffect(definition, tier) {
		const raw = definition.effects[tier];
		if (definition.effectType === ArtifactEffectType.UsernameColor) return { effect: typeof raw === "string" && raw.length > 0 ? `Username color: ${raw}` : "Username color" };
		if (definition.effectType === ArtifactEffectType.None) return { effect: "No ARP bonus" };
		if (typeof raw !== "number") return { effect: "No ARP bonus" };
		return describeNumericEffect(definition.effectType, raw);
	}
	function describeSetEffects(set) {
		return set.effects.map((effect) => {
			if (effect.unit === "cosmetic") return "username color";
			return describeNumericEffect(effect.type, effect.value).effect;
		}).join(", ");
	}
	function artifactSetForFamily(familyId) {
		return ARTIFACT_SETS.find((set) => set.unconfirmed !== true && set.memberIds.includes(familyId));
	}
	function artifactTipCopy(definition, tier, displayName) {
		const described = describeDefinitionEffect(definition, tier);
		const set = artifactSetForFamily(definition.id);
		const copy = {
			title: displayName,
			meta: `${definition.category} · ${TIER_LABELS[tier]}`,
			effect: described.effect
		};
		if (described.detail) copy.detail = described.detail;
		if (set) copy.setBonus = `Set: ${set.name} — ${describeSetEffects(set)} when all 3 are equipped`;
		return copy;
	}
	function artifactTipSpan(copy, visibleName) {
		const detailAttribute = copy.detail ? ` data-tip-detail="${escapeHtml(copy.detail)}"` : "";
		const bonusAttribute = copy.setBonus ? ` data-tip-set="${escapeHtml(copy.setBonus)}"` : "";
		const aria = [
			copy.title,
			copy.meta,
			copy.effect,
			copy.detail,
			copy.setBonus
		].filter((part) => Boolean(part)).join(". ");
		return `<span class="ao-artifact-tip" data-tip-title="${escapeHtml(copy.title)}" data-tip-meta="${escapeHtml(copy.meta)}" data-tip-effect="${escapeHtml(copy.effect)}"${detailAttribute}${bonusAttribute} aria-label="${escapeHtml(aria)}">${escapeHtml(visibleName)}</span>`;
	}
	function nextArtifactNameMatch(text, entries) {
		let match;
		for (const entry of entries) {
			const index = text.indexOf(entry.name);
			if (index === -1) continue;
			if (!match || index < match.index || index === match.index && entry.name.length > match.entry.name.length) match = {
				index,
				entry
			};
		}
		return match;
	}
	function wrapArtifactNames(text) {
		const entries = listArtifactNameEntries();
		let remaining = text;
		let html = "";
		while (remaining.length > 0) {
			const match = nextArtifactNameMatch(remaining, entries);
			if (!match) {
				html += escapeHtml(remaining);
				break;
			}
			html += escapeHtml(remaining.slice(0, match.index));
			const name = remaining.slice(match.index, match.index + match.entry.name.length);
			html += artifactTipSpan(artifactTipCopy(match.entry.definition, match.entry.tier, name), name);
			remaining = remaining.slice(match.index + match.entry.name.length);
		}
		return html;
	}
	function ensureArtifactTipFloat() {
		ensureOptimizerStyles();
		let tip = document.querySelector(`#${ARTIFACT_TIP_ID}`);
		if (tip) return tip;
		tip = document.createElement("div");
		tip.id = ARTIFACT_TIP_ID;
		tip.setAttribute("role", "tooltip");
		tip.hidden = true;
		document.body.append(tip);
		return tip;
	}
	function hideArtifactTip() {
		const tip = document.querySelector(`#${ARTIFACT_TIP_ID}`);
		if (!tip) return;
		tip.hidden = true;
		tip.replaceChildren();
	}
	function renderTipFloat(copy) {
		const detail = copy.detail ? `<div class="ao-artifact-tip-detail">${escapeHtml(copy.detail)}</div>` : "";
		const bonusHtml = copy.setBonus ? `<div class="ao-artifact-tip-set">${escapeHtml(copy.setBonus)}</div>` : "";
		return `
    <div class="ao-artifact-tip-name">${escapeHtml(copy.title)}</div>
    <div class="ao-artifact-tip-meta">${escapeHtml(copy.meta)}</div>
    <div class="ao-artifact-tip-effect">${escapeHtml(copy.effect)}</div>
    ${detail}
    ${bonusHtml}
  `;
	}
	function showArtifactTip(trigger) {
		const title = trigger.dataset.tipTitle;
		const meta = trigger.dataset.tipMeta;
		const effect = trigger.dataset.tipEffect;
		if (!title || !meta || !effect) return;
		const tip = ensureArtifactTipFloat();
		tip.innerHTML = renderTipFloat({
			title,
			meta,
			effect,
			...trigger.dataset.tipDetail && { detail: trigger.dataset.tipDetail },
			...trigger.dataset.tipSet && { setBonus: trigger.dataset.tipSet }
		});
		tip.hidden = false;
		const gap = 8;
		const rect = trigger.getBoundingClientRect();
		const tipRect = tip.getBoundingClientRect();
		let top = rect.bottom + gap;
		let left = rect.left;
		if (top + tipRect.height > window.innerHeight - gap) top = rect.top - tipRect.height - gap;
		if (left + tipRect.width > window.innerWidth - gap) left = window.innerWidth - tipRect.width - gap;
		if (left < gap) left = gap;
		if (top < gap) top = gap;
		tip.style.top = `${top}px`;
		tip.style.left = `${left}px`;
	}
	function tipTriggerFrom(target) {
		if (!(target instanceof Element)) return;
		const trigger = target.closest(".ao-artifact-tip");
		return trigger instanceof HTMLElement ? trigger : void 0;
	}
	var boundTipRoots = new WeakSet();
	function bindWindowTipDismiss() {
		if (document.documentElement.dataset.aoTipWatch === "1") return;
		document.documentElement.dataset.aoTipWatch = "1";
		window.addEventListener("scroll", hideArtifactTip, { capture: true });
		window.addEventListener("resize", hideArtifactTip);
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape") hideArtifactTip();
		});
	}
	function bindArtifactTips(root) {
		if (boundTipRoots.has(root)) return;
		boundTipRoots.add(root);
		bindWindowTipDismiss();
		root.addEventListener("pointerover", (event) => {
			if (!(event instanceof PointerEvent)) return;
			const trigger = tipTriggerFrom(event.target);
			if (trigger) showArtifactTip(trigger);
		});
		root.addEventListener("pointerout", (event) => {
			if (!(event instanceof PointerEvent)) return;
			const from = tipTriggerFrom(event.target);
			const to = tipTriggerFrom(event.relatedTarget);
			if (from && from !== to) hideArtifactTip();
		});
	}
	function actionUrgency(partial) {
		const urgency = {
			kind: partial.kind,
			readyAtMs: partial.readyAtMs,
			durationMs: partial.durationMs
		};
		if (partial.deadlineMs !== void 0) urgency.deadlineMs = partial.deadlineMs;
		if (partial.arp !== void 0) urgency.arp = partial.arp;
		if (partial.chain !== void 0) urgency.chain = partial.chain;
		return urgency;
	}
	var CHAIN_RANK = {
		before: 0,
		equip: 1,
		after: 2
	};
	var URGENCY_KIND_RANK = {
		action: 0,
		schedule: 1,
		info: 2
	};
	function urgencyDeadlineMs(urgency) {
		return urgency.deadlineMs ?? Number.POSITIVE_INFINITY;
	}
	function compareActionTodoUrgency(left, right) {
		const kindDelta = URGENCY_KIND_RANK[left.kind] - URGENCY_KIND_RANK[right.kind];
		if (kindDelta !== 0) return kindDelta;
		if (left.readyAtMs !== right.readyAtMs) return left.readyAtMs - right.readyAtMs;
		const leftChain = CHAIN_RANK[left.chain ?? "before"];
		const rightChain = CHAIN_RANK[right.chain ?? "before"];
		if (leftChain !== rightChain) return leftChain - rightChain;
		if (left.durationMs !== right.durationMs) return left.durationMs - right.durationMs;
		const leftSlack = urgencyDeadlineMs(left) - left.durationMs;
		const rightSlack = urgencyDeadlineMs(right) - right.durationMs;
		if (leftSlack !== rightSlack) return leftSlack - rightSlack;
		return (right.arp ?? 0) - (left.arp ?? 0);
	}
	function defaultTodoUrgency(todo) {
		if (todo.tone === "muted" && !todo.loadout) return {
			kind: "info",
			readyAtMs: 0,
			durationMs: 0
		};
		return {
			kind: "action",
			readyAtMs: 0,
			durationMs: 0
		};
	}
	function sortActionTodosByUrgency(todos) {
		return todos.toSorted((left, right) => compareActionTodoUrgency(left.urgency ?? defaultTodoUrgency(left), right.urgency ?? defaultTodoUrgency(right)));
	}
	function phaseChain(phase) {
		if (phase === "afterNow" || phase === "after") return "after";
		return "before";
	}
	var ACTIVITY_TODO_RULES = [
		{
			key: "steamQuests",
			isDue: (caps) => isActivityPending(caps, "steamQuests")
		},
		{
			key: "dailyQuests",
			isDue: (caps) => isActivityPending(caps, "dailyQuests")
		},
		{
			key: "watchTwitch",
			isDue: (caps) => isActivityAvailable(caps, "watchTwitch")
		},
		{
			key: "timeOnSite",
			isDue: (caps) => isActivityAvailable(caps, "timeOnSite")
		}
	];
	var UTC_DAILY_KEYS = new Set([
		"watchTwitch",
		"dailyQuests",
		"timeOnSite"
	]);
	var TIME_ON_SITE_DURATION_MS = BASE_ACTIVITY.timeOnSiteBasePerDay * 6e4;
	var STEAM_WEEK_MS = 6048e5;
	function isUtcDailyActivity(key) {
		return UTC_DAILY_KEYS.has(key);
	}
	function activityDurationMs(key, watchRemainingMs) {
		if (key === "watchTwitch") return Math.max(0, watchRemainingMs);
		if (key === "timeOnSite") return TIME_ON_SITE_DURATION_MS;
		return 0;
	}
	function twitchFullDayMs(stats, siteState) {
		return ((siteState.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) + comboBonusForActivity(stats, "watchTwitch")) * 6e4;
	}
	function loadoutStats(combo) {
		if (!combo) return;
		if ("artifacts" in combo && combo.artifacts.length > 0) return activityStatsForArtifacts(combo.artifacts);
		if ("timeOnSiteFlat" in combo) return combo;
	}
	function plannedWearForResets(result, swapWaitMs) {
		const deferred = result.deferredAllArp;
		if (deferred && deferred.waitMs > 0 && deferred.artifacts.length > 0) return {
			stats: activityStatsForArtifacts(deferred.artifacts),
			waitMs: deferred.waitMs
		};
		const steam = result.deferredSteam;
		if (steam && steam.artifacts.length > 0) return {
			stats: activityStatsForArtifacts(steam.artifacts),
			waitMs: steam.waitMs
		};
		const best = result.best;
		const current = result.current;
		if (best && (best.allArpPct ?? 0) > (current?.allArpPct ?? 0) && swapWaitMs > 0) return {
			stats: activityStatsForArtifacts(best.artifacts),
			waitMs: swapWaitMs
		};
	}
	function isActivityEnabled(settings, key) {
		return settings.activities[key]?.enabled;
	}
	function communityEventTodoUrgency(pending, etaMs) {
		if (pending.waitingPersonalArp > 0) return actionUrgency({
			kind: "action",
			readyAtMs: 0,
			durationMs: 0,
			arp: pending.waitingPersonalArp,
			chain: "before"
		});
		const waitingArp = pending.waitingCommunityArp + pending.imminentArp + pending.waitingPersonalArp;
		if (etaMs === void 0) return actionUrgency({
			kind: "info",
			readyAtMs: 0,
			durationMs: 0,
			arp: waitingArp
		});
		return actionUrgency({
			kind: "schedule",
			readyAtMs: etaMs,
			durationMs: 0,
			deadlineMs: etaMs,
			arp: waitingArp
		});
	}
	function pushCommunityEventTodo(todos, siteState, settings, allArpPct = 0) {
		const event = siteState.communityEvent;
		if (!isActivityEnabled(settings, "steamCommunityEvent") || !event?.isLive || !canEarnCommunityEventArp(event)) return;
		const pending = breakDownCommunityEventPending(event);
		if (pending.pendingCount <= 0 && nextLockedCommunityArpMilestone(event) === void 0) return;
		const { text, later } = describeCommunityEventPendingParts(event, allArpPct);
		const reasons = [];
		if (later) reasons.push({ text: later });
		if (event.libraryPending) reasons.push({ text: STEAM_LIBRARY_PENDING_HINT });
		const todo = {
			text: `Community Event: ${text}`,
			urgency: communityEventTodoUrgency(pending, estimateNextCommunityUnlock(event)?.etaMs)
		};
		if (reasons.length > 0) todo.reasons = reasons;
		todos.push(todo);
	}
	function battlePassClaimCountLabel(readyAll, readyArp) {
		if (readyArp <= 0) return readyAll === 1 ? "1 Battle Pass reward" : `${readyAll} Battle Pass rewards`;
		if (readyAll === readyArp) return readyArp === 1 ? "1 Battle Pass ARP Boost" : `${readyArp} Battle Pass ARP Boosts`;
		return `${readyAll} Battle Pass rewards (${readyArp === 1 ? "1 ARP Boost" : `${readyArp} ARP Boosts`})`;
	}
	function holdArpBoostReason(readyArp) {
		return `Hold ${readyArp === 1 ? "1 ARP Boost" : `${readyArp} ARP Boosts`} until All-ARP% is on`;
	}
	function pushHeldArpBattlePassTodos(todos, siteState, readyArp, hasScheduledAllArp, allArpReadyAtMs = 0) {
		const nonArp = battlePassReadyNonArp(siteState.battlePass);
		if (nonArp > 0) {
			const reasons = [{ text: holdArpBoostReason(readyArp) }];
			if (!hasScheduledAllArp) reasons.push({ text: "More boosts may unlock — claim those when All-ARP% is already on" });
			todos.push({
				text: `Claim ${battlePassClaimCountLabel(nonArp, 0)} now`,
				reasons,
				claimBattlePass: true,
				claimBattlePassSkipArp: true,
				urgency: {
					kind: "action",
					readyAtMs: 0,
					durationMs: 0,
					chain: "before"
				}
			});
		}
		if (hasScheduledAllArp) todos.push({
			text: `Claim ${battlePassClaimCountLabel(readyArp, readyArp)}`,
			urgency: {
				kind: "schedule",
				readyAtMs: allArpReadyAtMs,
				durationMs: 0,
				arp: readyArp,
				chain: "after"
			}
		});
	}
	function pushBattlePassTodo(todos, siteState, options) {
		const readyAll = siteState.battlePass?.readyToClaim ?? 0;
		if (readyAll <= 0) return;
		const readyArp = battlePassClaimableArp(siteState.battlePass);
		const { ownsAllArp, hasAllArpEquipped, afterAllArpEquipped = false, seasonEndsBeforeAllArp = false, allArpReadyAtMs = 0 } = options;
		const shouldWaitForAllArpSwap = ownsAllArp && !hasAllArpEquipped && !seasonEndsBeforeAllArp;
		const shouldShowClaimAll = shouldShowBattlePassClaimAll(siteState.battlePass, shouldWaitForAllArpSwap);
		const countLabel = battlePassClaimCountLabel(readyAll, readyArp);
		if (readyArp <= 0) {
			todos.push({
				text: `Claim ${countLabel}`,
				claimBattlePass: shouldShowClaimAll,
				urgency: {
					kind: "action",
					readyAtMs: 0,
					durationMs: 0,
					chain: "before"
				}
			});
			return;
		}
		if (hasAllArpEquipped) {
			todos.push({
				text: `Claim ${countLabel} now — All-ARP% is equipped`,
				claimBattlePass: shouldShowClaimAll,
				urgency: {
					kind: "action",
					readyAtMs: 0,
					durationMs: 0,
					arp: readyArp,
					chain: "before"
				}
			});
			return;
		}
		if (ownsAllArp && seasonEndsBeforeAllArp) {
			const left = battlePassRemainingMs(siteState.battlePass);
			const todo = {
				tone: "warn",
				text: `Claim ${countLabel} now — Battle Pass ends before All-ARP% can be equipped`,
				claimBattlePass: shouldShowClaimAll,
				urgency: actionUrgency({
					kind: "action",
					readyAtMs: 0,
					durationMs: 0,
					...typeof left === "number" && { deadlineMs: left },
					arp: readyArp,
					chain: "before"
				})
			};
			if (left !== void 0) todo.reasons = [{ text: `Ends in ${formatMs(left)}` }];
			todos.push(todo);
			return;
		}
		if (ownsAllArp) {
			pushHeldArpBattlePassTodos(todos, siteState, readyArp, afterAllArpEquipped, allArpReadyAtMs);
			return;
		}
		todos.push({
			text: `Claim ${countLabel}`,
			claimBattlePass: shouldShowClaimAll,
			urgency: {
				kind: "action",
				readyAtMs: 0,
				durationMs: 0,
				arp: readyArp,
				chain: "before"
			}
		});
	}
	function comboBonusForActivity(combo, key) {
		if (!combo) return 0;
		switch (key) {
			case "steamQuests": return combo.steamQuestsFlat;
			case "watchTwitch": return combo.watchTwitchFlat;
			case "discordPoll": return combo.discordPollFlat;
			case "timeOnSite": return loadoutStats(combo)?.timeOnSiteFlat ?? 0;
			default: return 0;
		}
	}
	function twitchActivityLabel(options) {
		if (options.phase === "after" || options.phase === "afterNow") return "Watch Twitch";
		if (options.phase === "before" && options.waitMs > 0 && !canFinishTwitchAfterUnlock(options.waitMs, options.watchRemainingMs, options.utcDailyEndBufferMs)) return "Watch Twitch now";
		if (options.utcDeadline) return `Watch Twitch (${utcResetDeadlineLabel()})`;
		return `Watch Twitch${options.beforeSwap ? " before swapping" : ""}`;
	}
	function twitchArpReason(options) {
		const arp = Math.round(options.watchRemainingMs / 6e4 * (1 + options.allArpPct));
		if (arp <= 0) return;
		if (options.upcomingReset === "utc") return { text: `+${arp} ARP after 00:00 UTC` };
		if (options.phase === "after" && options.waitMs > 0) {
			const left = msAfterUnlockBeforeReset(options.waitMs);
			if (left > 0) return { text: `+${arp} ARP (fits in ${formatMs(left)} before reset)` };
		}
		return { text: `+${arp} ARP` };
	}
	function discordPollActivityLabel(bonus, options) {
		const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : "";
		const nextPost = formatMs(msUntilNextDiscordPollPost());
		if (options.phase === "after" && options.waitMs > 0) return `Vote Discord Poll after unlock (${formatMs(options.waitMs)} wait, next post in ${nextPost})${bonusPart}`;
		if (options.phase === "before") return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
		return `Vote Discord Poll${options.beforeSwap ? " before swapping" : ""}${bonusPart}`;
	}
	function steamQuestCountLabel(count) {
		if (count === 1) return "1 Steam Quest";
		if (count > 1) return `${count} Steam Quests`;
		return "Steam Quest(s)";
	}
	function steamQuestsActivityLabel(bonus, options) {
		const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : "";
		const beforePart = options.beforeSwap ? " before swapping" : "";
		return `Complete ${steamQuestCountLabel(options.pendingCount)}${beforePart}${bonusPart}`;
	}
	function dailyQuestCountLabel(pending) {
		const count = pending.length;
		if (count === 0) return "Daily Quests";
		const daily = pending.filter((quest) => quest.kind === "daily").length;
		const weekend = pending.filter((quest) => quest.kind === "weekend").length;
		if (daily > 0 && weekend > 0) return count === 2 ? "Daily and Weekend Quests" : `${count} Daily and Weekend Quests`;
		if (weekend > 0) return count === 1 ? "Weekend Quest" : `${count} Weekend Quests`;
		return count === 1 ? "Daily Quest" : `${count} Daily Quests`;
	}
	function dailyQuestsActivityLabel(pending, options) {
		const beforePart = options.beforeSwap ? " before swapping" : "";
		const questsName = dailyQuestCountLabel(pending);
		if (options.utcDeadline) return `Complete ${questsName} (${utcResetDeadlineLabel()})`;
		return `Complete ${questsName}${beforePart}`;
	}
	function activityLabel(key, bonus, options) {
		const beforePart = options.beforeSwap ? " before swapping" : "";
		switch (key) {
			case "steamQuests": return steamQuestsActivityLabel(bonus, {
				beforeSwap: options.beforeSwap,
				pendingCount: options.steamQuestCount ?? 0
			});
			case "watchTwitch": return twitchActivityLabel(options);
			case "dailyQuests": return dailyQuestsActivityLabel(options.dailyQuestPending ?? [], {
				beforeSwap: options.beforeSwap,
				utcDeadline: options.utcDeadline
			});
			case "discordPoll": return discordPollActivityLabel(bonus, options);
			case "timeOnSite": return `Earn Time on Site ARP${(options.phase === "after" || options.phase === "afterNow") && bonus > 0 ? " (equip ToS bonus before 5 ARP)" : ""}${beforePart}`;
			default: return key;
		}
	}
	function msAfterUnlockBeforeReset(waitMs, now = new Date()) {
		return Math.max(0, msUntilUtcMidnight(now) - waitMs);
	}
	function canFinishTwitchAfterUnlock(waitMs, watchRemainingMs, bufferMs, now = new Date()) {
		return Math.max(0, msUntilUtcMidnight(now) - waitMs - bufferMs) >= watchRemainingMs;
	}
	function activityWindowArp(combo, key, siteState, options) {
		const stats = loadoutStats(combo);
		const allArpPct = stats?.allArpPct ?? combo?.allArpPct ?? 0;
		let base = 0;
		switch (key) {
			case "watchTwitch":
				base = siteState === void 0 || options?.fullDay === true ? (siteState?.watchTwitch?.capArp ?? BASE_ACTIVITY.watchTwitchBasePerDay) + (stats?.watchTwitchFlat ?? comboBonusForActivity(combo, key)) : twitchWatchRemainingMs(siteState, stats?.watchTwitchFlat ?? comboBonusForActivity(combo, key)) / 6e4;
				break;
			case "dailyQuests":
				base = BASE_ACTIVITY.dailyQuestBase;
				break;
			case "timeOnSite":
				base = BASE_ACTIVITY.timeOnSiteBasePerDay + (stats?.timeOnSiteFlat ?? 0);
				break;
			case "steamQuests": {
				const remaining = siteState ? remainingSteamQuestRewards(siteState) : [...BASE_ACTIVITY.steamQuestBases];
				const bases = options?.fullDay === true ? [...BASE_ACTIVITY.steamQuestBases] : remaining;
				const flat = stats?.steamQuestsFlat ?? comboBonusForActivity(combo, key);
				return (bases.reduce((sum, value) => sum + value, 0) + flat * bases.length) * (1 + allArpPct);
			}
			case "discordPoll": base = BASE_ACTIVITY.discordPollBase;
		}
		const flat = key === "watchTwitch" || key === "timeOnSite" ? 0 : comboBonusForActivity(combo, key);
		return (base + flat) * (1 + allArpPct);
	}
	function resolveUtcDailyPhase(options) {
		const { key, needsSwap, waitMs, current, best, afterNow, hasImmediateEquip, watchRemainingMs, siteState, plannedWear, utcDailyEndBufferMs: cutoffMs } = options;
		const currentArp = activityWindowArp(current, key, siteState);
		const afterNowArp = activityWindowArp(afterNow ?? current, key, siteState);
		if (needsSwap && hasImmediateEquip && afterNowArp >= currentArp) return "afterNow";
		const futureWaitMs = plannedWear?.waitMs ?? waitMs;
		const futureArp = activityWindowArp(plannedWear?.stats ?? best, key, siteState);
		const durationMs = activityDurationMs(key, watchRemainingMs);
		if ((key === "watchTwitch" ? canFinishTwitchAfterUnlock(futureWaitMs, watchRemainingMs, cutoffMs) : canCompleteInWearWindow(0, msUntilUtcMidnight(), futureWaitMs, durationMs)) && futureArp > currentArp) return "after";
		return "before";
	}
	function resolveActivityPhase(options) {
		const { key, needsSwap, expiresBeforeUnlock, currentBonus, bestBonus, afterNowBonus, waitMs, canEquipBeforeReset, isUtcDaily, current, best, afterNow, hasImmediateEquip, watchRemainingMs, siteState, plannedWear, utcDailyEndBufferMs: cutoffMs } = options;
		if (isUtcDaily) return resolveUtcDailyPhase({
			key,
			needsSwap,
			waitMs,
			current,
			best,
			afterNow,
			hasImmediateEquip,
			watchRemainingMs,
			siteState,
			plannedWear,
			utcDailyEndBufferMs: cutoffMs
		});
		if (key === "steamQuests" && plannedWear && activityWindowArp(plannedWear.stats, key, siteState) > activityWindowArp(current, key, siteState) && canCompleteInWearWindow(0, msUntilNextSteamQuestWeek(), plannedWear.waitMs, 0)) return "after";
		if (!needsSwap) return "other";
		if (hasImmediateEquip && afterNowBonus >= currentBonus) return "afterNow";
		if (expiresBeforeUnlock || currentBonus > bestBonus) return "before";
		if (bestBonus > currentBonus && (waitMs === 0 || canEquipBeforeReset)) return "after";
		if (currentBonus > 0 && currentBonus >= bestBonus) return "before";
		if (bestBonus <= 0) return "other";
		return !canEquipBeforeReset && waitMs > 0 ? "other" : "after";
	}
	function allArpPctForPhase(phase, current, best, afterNow, plannedWear) {
		if (phase === "after") return plannedWear?.stats.allArpPct ?? best?.allArpPct ?? 0;
		if (phase === "afterNow") return afterNow?.allArpPct ?? current?.allArpPct ?? 0;
		return current?.allArpPct ?? 0;
	}
	function bonusForActivityPhase(phase, currentBonus, bestBonus, afterNowBonus = 0) {
		if (phase === "after") return bestBonus;
		if (phase === "afterNow") return afterNowBonus;
		if (phase === "before") return currentBonus;
		return 0;
	}
	function activityTodoArp(options) {
		const { key, bonusForText, allArpPct, twitchArp } = options;
		if (key === "watchTwitch") return twitchArp;
		if (key === "timeOnSite") return Math.round((BASE_ACTIVITY.timeOnSiteBasePerDay + bonusForText) * (1 + allArpPct));
		return bonusForText;
	}
	function activityTodoUrgency(options) {
		const { key, phase, waitMs, watchRemainingMs, isUtcDaily, bonusForText, allArpPct } = options;
		const readyAtMs = phase === "after" ? waitMs : 0;
		const twitchArp = key === "watchTwitch" ? Math.round(Math.max(0, watchRemainingMs) / 6e4 * (1 + allArpPct)) : 0;
		return actionUrgency({
			kind: readyAtMs > 0 ? "schedule" : "action",
			readyAtMs,
			durationMs: activityDurationMs(key, watchRemainingMs),
			...isUtcDaily && { deadlineMs: msUntilUtcMidnight() },
			arp: activityTodoArp({
				key,
				bonusForText,
				allArpPct,
				twitchArp
			}),
			chain: phaseChain(phase)
		});
	}
	function steamQuestsTodoExtras(siteState, bonus) {
		const pending = remainingSteamQuestRows(siteState);
		const reasons = [];
		if (bonus > 0) reasons.push({ text: "Equip bonus before starting" });
		if (pending.some((quest) => quest.libraryPending === true)) reasons.push({ text: STEAM_LIBRARY_PENDING_HINT });
		if (reasons.length === 0) return { count: pending.length };
		return {
			count: pending.length,
			reasons
		};
	}
	function dailyQuestsTodoExtras(siteState) {
		const pending = remainingDailyQuestRows(siteState);
		if (pending.map((quest) => quest.name).filter((name) => name.length > 0).length === 0) return { pending };
		return { pending };
	}
	function activityTodoReasons(options) {
		const { key, phase, waitMs, watchRemainingMs, allArpPct, upcomingReset, steamQuests, dailyQuests } = options;
		const reasons = [];
		if (key === "watchTwitch") {
			const twitchReason = twitchArpReason({
				phase,
				waitMs,
				watchRemainingMs,
				allArpPct,
				...upcomingReset && { upcomingReset }
			});
			if (twitchReason) reasons.push(twitchReason);
		} else if (steamQuests?.reasons) reasons.push(...steamQuests.reasons);
		else if (dailyQuests?.reasons) reasons.push(...dailyQuests.reasons);
		if (upcomingReset === "steam") reasons.push({ text: "after Monday 00:00 UTC reset" });
		else if (upcomingReset === "utc" && key !== "watchTwitch") reasons.push({ text: "after 00:00 UTC reset" });
		return reasons.length > 0 ? reasons : void 0;
	}
	function buildActivityTodo(options) {
		const { key, phase, needsSwap, currentBonus, bestBonus, afterNowBonus, isUtcDaily, waitMs, watchRemainingMs, allArpPct, siteState, utcDailyEndBufferMs: cutoffMs, upcomingReset } = options;
		const bonusForText = bonusForActivityPhase(phase, currentBonus, bestBonus, afterNowBonus);
		const steamQuests = key === "steamQuests" ? steamQuestsTodoExtras(siteState, bonusForText) : void 0;
		const dailyQuests = key === "dailyQuests" ? dailyQuestsTodoExtras(siteState) : void 0;
		const todo = {
			text: activityLabel(key, bonusForText, {
				beforeSwap: phase === "before" && needsSwap && currentBonus > 0,
				utcDeadline: isUtcDaily && upcomingReset === void 0,
				phase,
				waitMs,
				watchRemainingMs,
				utcDailyEndBufferMs: cutoffMs,
				...steamQuests && { steamQuestCount: steamQuests.count },
				...dailyQuests && { dailyQuestPending: dailyQuests.pending }
			}),
			urgency: activityTodoUrgency({
				key,
				phase,
				waitMs,
				watchRemainingMs,
				isUtcDaily: isUtcDaily && upcomingReset === void 0,
				bonusForText,
				allArpPct
			})
		};
		const reasons = activityTodoReasons({
			key,
			phase,
			waitMs,
			watchRemainingMs,
			allArpPct,
			...upcomingReset && { upcomingReset },
			...steamQuests && { steamQuests },
			...dailyQuests && { dailyQuests }
		});
		if (reasons) todo.reasons = reasons;
		if (key === "watchTwitch" && upcomingReset === void 0) todo.openTwitchStream = true;
		if (isUtcDaily && upcomingReset === void 0 && msUntilUtcMidnight() <= 72e5) todo.tone = "warn";
		return todo;
	}
	function pushTodoByPhase(buckets, phase, todo) {
		if (phase === "before") {
			buckets.beforeSwap.push(todo);
			return;
		}
		if (phase === "afterNow") {
			buckets.afterNow.push(todo);
			return;
		}
		if (phase === "after") {
			buckets.afterSwap.push(todo);
			return;
		}
		buckets.other.push(todo);
	}
	function utcResetTodoRank(todo) {
		if (/(Daily|Weekend) quest/i.test(todo.text)) return 0;
		if (/Watch Twitch/i.test(todo.text)) return 1;
		return 2;
	}
	function sortTodosByUtcDeadline(items) {
		return items.toSorted((left, right) => {
			const leftUrgent = /00:00 UTC/i.test(left.text) ? 0 : 1;
			const rightUrgent = /00:00 UTC/i.test(right.text) ? 0 : 1;
			if (leftUrgent !== rightUrgent) return leftUrgent - rightUrgent;
			return utcResetTodoRank(left) - utcResetTodoRank(right);
		});
	}
	function upcomingResetAtMs(key, siteState, plannedWear, isTodayDue) {
		if (!plannedWear || isTodayDue) return;
		if (key === "steamQuests") {
			if (isActivityPending(siteState.caps, "steamQuests")) return;
			const monday = msUntilNextSteamQuestWeek();
			if (!canCompleteInWearWindow(monday, monday + STEAM_WEEK_MS, plannedWear.waitMs, 0)) return;
			return monday;
		}
		if (!isUtcDailyActivity(key)) return;
		const midnight = msUntilUtcMidnight();
		const duration = key === "watchTwitch" ? twitchFullDayMs(plannedWear.stats, siteState) : activityDurationMs(key, 0);
		if (!canCompleteInWearWindow(midnight, midnight + 864e5, plannedWear.waitMs, duration)) return;
		return midnight;
	}
	function waitMsForActivityPhase(phase, delayWaitMs, waitMs) {
		if (phase === "afterNow") return 0;
		if (phase === "after") return delayWaitMs;
		return waitMs;
	}
	function appendDueActivityTodo(options) {
		const { buckets, rule, needsSwap, current, best, afterNow, hasImmediateEquip, watchAfterMs, siteState, plannedWear, currentBonus, bestBonus, afterNowBonus, isUtcDaily, delayWaitMs, waitMs, isExpiresBeforeUnlock, utcDailyEndBufferMs: cutoffMs } = options;
		const phase = resolveActivityPhase({
			key: rule.key,
			needsSwap,
			expiresBeforeUnlock: isExpiresBeforeUnlock,
			currentBonus,
			bestBonus,
			afterNowBonus,
			waitMs: delayWaitMs,
			canEquipBeforeReset: delayWaitMs <= msUntilUtcMidnight(),
			isUtcDaily,
			current,
			best,
			afterNow,
			hasImmediateEquip,
			watchRemainingMs: watchAfterMs,
			siteState,
			plannedWear,
			utcDailyEndBufferMs: cutoffMs
		});
		const watchRemainingMs = rule.key === "watchTwitch" ? twitchWatchRemainingMs(siteState, bonusForActivityPhase(phase, currentBonus, bestBonus, afterNowBonus)) : watchAfterMs;
		pushTodoByPhase(buckets, phase, buildActivityTodo({
			key: rule.key,
			phase,
			needsSwap,
			currentBonus,
			bestBonus,
			afterNowBonus,
			isUtcDaily,
			waitMs: waitMsForActivityPhase(phase, delayWaitMs, waitMs),
			watchRemainingMs,
			allArpPct: allArpPctForPhase(phase, current, best, afterNow, plannedWear),
			siteState,
			utcDailyEndBufferMs: cutoffMs
		}));
	}
	function appendUpcomingActivityTodo(options) {
		const { buckets, rule, needsSwap, plannedWear, upcomingAt, currentBonus, bestBonus, afterNowBonus, isUtcDaily, watchAfterMs, siteState, utcDailyEndBufferMs: cutoffMs } = options;
		const upcomingWatchMs = rule.key === "watchTwitch" ? twitchFullDayMs(plannedWear.stats, siteState) : watchAfterMs;
		pushTodoByPhase(buckets, "after", buildActivityTodo({
			key: rule.key,
			phase: "after",
			needsSwap,
			currentBonus,
			bestBonus,
			afterNowBonus,
			isUtcDaily,
			waitMs: Math.max(upcomingAt, plannedWear.waitMs),
			watchRemainingMs: upcomingWatchMs,
			allArpPct: plannedWear.stats.allArpPct,
			siteState,
			utcDailyEndBufferMs: cutoffMs,
			upcomingReset: rule.key === "steamQuests" ? "steam" : "utc"
		}));
	}
	function isSequencedActivityDue(rule, settings, siteState, watchRemainingMs) {
		if (!isActivityEnabled(settings, rule.key)) return false;
		if (rule.key === "watchTwitch") return watchRemainingMs > 0 && isActivityAvailable(siteState.caps, "watchTwitch");
		return rule.isDue(siteState.caps);
	}
	function buildSequencedActivityTodos(result, settings, siteState, options) {
		const buckets = {
			beforeSwap: [],
			afterNow: [],
			afterSwap: [],
			other: []
		};
		const { needsSwap, waitMs: fallbackWaitMs } = options;
		const current = result.current;
		const best = result.best;
		const plan = best ? planLoadoutChanges(best.artifacts, current, settings, result.slotLocks) : void 0;
		const waitMs = plan?.waitMs ?? fallbackWaitMs;
		const cutoffMs = utcDailyEndBufferMs(settings);
		const plannedWear = plannedWearForResets(result, waitMs);
		const hasImmediateEquip = (plan?.now.length ?? 0) > 0;
		const afterNow = best && plan ? activityStatsForArtifacts(artifactsAfterImmediateEquip(current, best, plan)) : void 0;
		const watchAfterMs = twitchWatchRemainingMs(siteState, Math.max(comboBonusForActivity(current, "watchTwitch"), comboBonusForActivity(afterNow ?? current, "watchTwitch"), comboBonusForActivity(best, "watchTwitch"), comboBonusForActivity(plannedWear?.stats, "watchTwitch")));
		for (const rule of ACTIVITY_TODO_RULES) {
			if (!isActivityEnabled(settings, rule.key)) continue;
			const isTodayDue = isSequencedActivityDue(rule, settings, siteState, watchAfterMs);
			const upcomingAt = upcomingResetAtMs(rule.key, siteState, plannedWear, isTodayDue);
			if (!isTodayDue && upcomingAt === void 0) continue;
			const currentBonus = comboBonusForActivity(current, rule.key);
			const bestBonus = comboBonusForActivity(plannedWear?.stats ?? best, rule.key);
			const afterNowBonus = comboBonusForActivity(afterNow ?? current, rule.key);
			const isUtcDaily = isUtcDailyActivity(rule.key);
			const delayWaitMs = plannedWear?.waitMs ?? waitMs;
			const isExpiresBeforeUnlock = isUtcDaily && delayWaitMs > msUntilUtcMidnight() && delayWaitMs > 0;
			if (isTodayDue) appendDueActivityTodo({
				buckets,
				rule,
				needsSwap,
				current,
				best,
				afterNow,
				hasImmediateEquip,
				watchAfterMs,
				siteState,
				plannedWear,
				currentBonus,
				bestBonus,
				afterNowBonus,
				isUtcDaily,
				delayWaitMs,
				waitMs,
				isExpiresBeforeUnlock,
				utcDailyEndBufferMs: cutoffMs
			});
			if (upcomingAt !== void 0 && plannedWear) appendUpcomingActivityTodo({
				buckets,
				rule,
				needsSwap,
				plannedWear,
				upcomingAt,
				currentBonus,
				bestBonus,
				afterNowBonus,
				isUtcDaily,
				watchAfterMs,
				siteState,
				utcDailyEndBufferMs: cutoffMs
			});
		}
		pushCommunityEventTodo(buckets.other, siteState, settings, current?.allArpPct ?? 0);
		return {
			beforeSwap: sortTodosByUtcDeadline(buckets.beforeSwap),
			afterNow: sortTodosByUtcDeadline(buckets.afterNow),
			afterSwap: sortTodosByUtcDeadline(buckets.afterSwap),
			other: sortTodosByUtcDeadline(buckets.other)
		};
	}
	function flatBonusReason(amount, label, waitMs) {
		return waitMs > msUntilUtcMidnight() ? `+${amount} ${label} after unlock` : `+${amount} ${label}`;
	}
	function pushAllArpEquipReasons(reasons, allArpPct, siteState) {
		if (allArpPct <= 0) return;
		const event = siteState.communityEvent;
		if (!event?.isLive || !canEarnCommunityEventArp(event)) return;
		const pending = breakDownCommunityEventPending(event);
		if (pending.waitingPersonalArp > 0) reasons.push({ text: `All-ARP% before personal Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp, allArpPct)})` });
		else if (pending.waitingCommunityArp > 0) reasons.push({ text: `All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp, allArpPct)})` });
	}
	function pushFlatEquipReason(reasons, amount, waitMs, isDueNow, isDueAfterReset, nowLabel, laterLabel) {
		if (amount <= 0 || !isDueNow && !isDueAfterReset) return;
		reasons.push({ text: flatBonusReason(amount, isDueNow ? nowLabel : laterLabel, waitMs) });
	}
	function collectEquipReasons(siteState, waitMs, stepArtifacts) {
		const reasons = [];
		const caps = siteState.caps;
		const stats = activityStatsForArtifacts(stepArtifacts);
		pushAllArpEquipReasons(reasons, stats.allArpPct, siteState);
		const isNextUtcResetInLock = isResetInWearWindow(msUntilUtcMidnight(), waitMs);
		const isSteamDueNow = isActivityPending(caps, "steamQuests");
		pushFlatEquipReason(reasons, stats.steamQuestsFlat, waitMs, isSteamDueNow, isResetInWearWindow(msUntilNextSteamQuestWeek(), waitMs), "Steam Quests", "Steam Quests after Monday reset");
		pushFlatEquipReason(reasons, stats.watchTwitchFlat, waitMs, isActivityAvailable(caps, "watchTwitch"), isNextUtcResetInLock, "Watch Twitch cap", "Watch Twitch cap after 00:00 UTC");
		if (stats.discordPollFlat > 0 && isActivityPending(caps, "discordPoll")) reasons.push({ text: flatBonusReason(stats.discordPollFlat, "Discord Poll", waitMs) });
		if (stats.dailyCalendarFlat > 0) reasons.push({ text: flatBonusReason(stats.dailyCalendarFlat, "Tomorrow's Daily Calendar ", waitMs) });
		if (waitMs > 0 && isArtifactsShowroomPage()) reasons.push({ text: "Still stuck after Refresh? Upgrade a maxed artifact manually (Warrior Script) — 0 fragments" });
		return reasons;
	}
	function comboArtifactsByIds(combo, ids) {
		return combo.artifacts.filter((artifact) => ids.has(artifact.instanceId));
	}
	function buildEquipTodo(options) {
		const { headline, loadout, reasons, tone, urgency } = options;
		const todo = {
			text: `${headline} - ${loadout}`,
			loadout,
			urgency: urgency ?? {
				kind: "action",
				readyAtMs: 0,
				durationMs: 0,
				chain: "equip"
			}
		};
		if (reasons.length > 0) todo.reasons = reasons;
		if (tone) todo.tone = tone;
		return todo;
	}
	function deferredSteamTodo(deferred, siteState) {
		const { waitMs, artifacts } = deferred;
		return buildEquipTodo({
			headline: waitMs > 0 ? `Equip Steam Quests set in ${formatMs(waitMs)}` : "Equip Steam Quests set now",
			loadout: loadoutLabel(artifacts),
			reasons: collectEquipReasons(siteState, waitMs, artifacts),
			urgency: actionUrgency({
				kind: waitMs > 0 ? "schedule" : "action",
				readyAtMs: waitMs,
				durationMs: 0,
				deadlineMs: msUntilNextSteamQuestWeek(),
				chain: "equip"
			})
		});
	}
	function deferredAllArpTodo(deferred) {
		const { waitMs, artifacts, unlock } = deferred;
		const parts = [];
		if (unlock.targetHours !== void 0) parts.push(`Before ${unlock.targetHours.toLocaleString()}h`);
		if (unlock.etaMs !== void 0) parts.push(`ETA ${formatCommunityEta(unlock.etaMs)}`);
		parts.push(formatCommunityEventArp(unlock.arpReward));
		return buildEquipTodo({
			headline: `Equip All-ARP% in ${formatMs(waitMs)}`,
			loadout: loadoutLabel(artifacts),
			reasons: [{ text: parts.join(" · ") }],
			urgency: actionUrgency({
				kind: "schedule",
				readyAtMs: waitMs,
				durationMs: 0,
				...typeof unlock.etaMs === "number" && { deadlineMs: unlock.etaMs },
				arp: unlock.arpReward,
				chain: "equip"
			})
		});
	}
	function allArpArtifactsFromResult(result) {
		const loadout = result.allArpLoadout;
		if (loadout && loadout.artifacts.length > 0 && loadout.allArpPct > 0) return loadout.artifacts;
		const deferred = result.deferredAllArp?.artifacts;
		if (deferred && deferred.length > 0) return deferred;
	}
	function battlePassAllArpEquipWaitMs(options) {
		const { result, plan, isNeedsSwap, settings, allArpArtifacts } = options;
		const best = result.best;
		if (isNeedsSwap && best !== void 0 && best.allArpPct <= 0 && !isSameLoadout(best.artifacts, allArpArtifacts)) return (plan?.waitMs ?? 0) + COOLDOWN_MS;
		const wearing = result.current?.artifacts;
		const targetIds = new Set(allArpArtifacts.map((artifact) => artifact.instanceId));
		let waitMs = 0;
		for (const position of [
			1,
			2,
			3
		]) {
			const equipped = wearing?.find((artifact) => artifact.equippedPosition === position);
			if (equipped && targetIds.has(equipped.instanceId)) continue;
			waitMs = Math.max(waitMs, showroomCooldownRemainingMs(settings, position, {
				...result.slotLocks && { slotLocks: result.slotLocks },
				...typeof equipped?.slotLocked === "boolean" && { equippedSlotLocked: equipped.slotLocked }
			}));
		}
		return waitMs;
	}
	function battlePassAllArpEquipTodo(options) {
		const artifacts = allArpArtifactsFromResult(options.result);
		const waitMs = battlePassAllArpEquipWaitMs({
			result: options.result,
			plan: options.plan,
			isNeedsSwap: options.isNeedsSwap,
			settings: options.settings,
			allArpArtifacts: artifacts ?? []
		});
		const arpReady = battlePassClaimableArp(options.siteState.battlePass);
		return buildEquipTodo({
			headline: waitMs > 0 ? `Equip All-ARP% in ${formatMs(waitMs)}` : "Equip All-ARP%",
			loadout: artifacts ? loadoutLabel(artifacts) : "All-ARP% set",
			reasons: [],
			urgency: actionUrgency({
				kind: waitMs > 0 ? "schedule" : "action",
				readyAtMs: waitMs,
				durationMs: 0,
				...arpReady > 0 && { arp: arpReady },
				chain: "equip"
			})
		});
	}
	function battlePassAllArpSchedule(options) {
		const deferred = options.result.deferredAllArp;
		const artifacts = allArpArtifactsFromResult(options.result);
		const shouldAddEquipTodo = options.shouldDeferBattlePassClaim && options.result.worthDedicatedAllArpForBattlePass === true && !options.hasPlannedAllArp && deferred === void 0 && (artifacts !== void 0 || options.result.hasAllArpOwned === true);
		const hasScheduledAllArp = options.hasPlannedAllArp || deferred !== void 0 || shouldAddEquipTodo;
		if (options.hasPlannedAllArp) return {
			hasScheduledAllArp,
			readyAtMs: options.waitMs,
			shouldAddEquipTodo
		};
		if (deferred) return {
			hasScheduledAllArp,
			readyAtMs: deferred.waitMs,
			shouldAddEquipTodo
		};
		if (shouldAddEquipTodo && artifacts) return {
			hasScheduledAllArp,
			readyAtMs: battlePassAllArpEquipWaitMs({
				result: options.result,
				plan: options.plan,
				isNeedsSwap: options.isNeedsSwap,
				settings: options.settings,
				allArpArtifacts: artifacts
			}),
			shouldAddEquipTodo
		};
		if (shouldAddEquipTodo) return {
			hasScheduledAllArp,
			readyAtMs: (options.plan?.waitMs ?? 0) + (options.isNeedsSwap ? COOLDOWN_MS : 0),
			shouldAddEquipTodo
		};
		return {
			hasScheduledAllArp,
			readyAtMs: 0,
			shouldAddEquipTodo
		};
	}
	function pushCommunityAllArpGuards(todos, siteState, isLocked, hasDeferredAllArp) {
		if (hasDeferredAllArp) return;
		const event = siteState.communityEvent;
		if (isLocked || !event || !canEarnCommunityEventArp(event)) return;
		const pending = breakDownCommunityEventPending(event);
		if (pending.waitingPersonalArp > 0) {
			todos.push({
				tone: "warn",
				text: `Equip All-ARP% before playing more Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)`,
				urgency: {
					kind: "action",
					readyAtMs: 0,
					durationMs: 0,
					arp: pending.waitingPersonalArp,
					chain: "equip"
				}
			});
			return;
		}
		if (pending.waitingCommunityArp <= 0) return;
		todos.push({
			tone: "muted",
			text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})`,
			urgency: {
				kind: "info",
				readyAtMs: 0,
				durationMs: 0,
				arp: pending.waitingCommunityArp
			}
		});
	}
	function pushAllArpGuardTodos(todos, siteState, options) {
		const { ownsAllArp, hasAllArpEquipped, isLocked, deferBattlePassClaims } = options;
		if (!ownsAllArp || hasAllArpEquipped) return;
		const hasScheduledAllArp = options.hasScheduledAllArp === true || options.hasPlannedAllArp === true;
		if (deferBattlePassClaims && battlePassClaimableArp(siteState.battlePass) > 0 && battlePassReadyNonArp(siteState.battlePass) === 0) {
			const arpReady = battlePassClaimableArp(siteState.battlePass);
			todos.push({
				kind: "caution",
				tone: hasScheduledAllArp ? "warn" : "muted",
				text: `Don't claim Battle Pass ARP Boost yet (${arpReady} ready)`,
				reasons: [{ text: hasScheduledAllArp ? "Claim after All-ARP% is on" : "More boosts may unlock — claim when All-ARP% is already on" }]
			});
		}
		pushCommunityAllArpGuards(todos, siteState, isLocked, options.hasDeferredAllArp === true);
	}
	function pushScheduledAllArpTodos(todos, result, settings, siteState, plan, isNeedsSwap, shouldAddBattlePassEquip) {
		const deferredAllArp = result.deferredAllArp;
		if (deferredAllArp && !isSameLoadout(result.best?.artifacts ?? [], deferredAllArp.artifacts)) {
			todos.push(deferredAllArpTodo(deferredAllArp));
			return;
		}
		if (deferredAllArp || !shouldAddBattlePassEquip) return;
		const allArpTodo = battlePassAllArpEquipTodo({
			result,
			settings,
			siteState,
			plan,
			isNeedsSwap
		});
		if (allArpTodo) todos.push(allArpTodo);
	}
	function nowEquipHeadline(plan) {
		return `Equip: ${plan.now.map((change) => change.displayName).join(" + ")} now (${plan.now.map((change) => `slot ${change.position}`).join(", ")} free)`;
	}
	function buildPartialEquipTodos(plan, fullLabel, nowReasons, laterReasons) {
		if (plan.now.length === 0) return;
		const nowTodo = {
			text: nowEquipHeadline(plan),
			urgency: {
				kind: "action",
				readyAtMs: 0,
				durationMs: 0,
				chain: "equip"
			}
		};
		if (nowReasons.length > 0) nowTodo.reasons = nowReasons;
		if (plan.laterNames.length > 0) return [nowTodo, buildEquipTodo({
			headline: `Equip in ${formatMs(plan.waitMs)}`,
			loadout: plan.laterNames.join(" + "),
			reasons: laterReasons,
			urgency: {
				kind: "schedule",
				readyAtMs: plan.waitMs,
				durationMs: 0,
				chain: "equip"
			}
		})];
		if (plan.lockedSlots.length > 0) return [buildEquipTodo({
			headline: nowTodo.text,
			loadout: fullLabel,
			reasons: nowReasons
		})];
	}
	function buildSwapEquipTodos(options) {
		const { best, current, settings, siteState, slotLocks, isLocked, waitMs, beforeSwapCount, upgrades } = options;
		const plan = planLoadoutChanges(best.artifacts, current, settings, slotLocks);
		const swapWaitMs = plan.waitMs > 0 ? plan.waitMs : waitMs;
		const laterIds = new Set(plan.later.map((change) => change.artifactId));
		const nowIds = new Set(plan.now.map((change) => change.artifactId));
		const laterArtifacts = comboArtifactsByIds(best, laterIds);
		const nowArtifacts = comboArtifactsByIds(best, nowIds);
		const laterReasons = collectEquipReasons(siteState, swapWaitMs, laterArtifacts.length > 0 ? laterArtifacts : best.artifacts);
		const nowReasons = nowArtifacts.length > 0 ? collectEquipReasons(siteState, 0, nowArtifacts) : laterReasons;
		const label = loadoutLabel(best.artifacts);
		const nowUpgrades = upgradeTodosFor(upgrades, new Set(plan.now.map((change) => change.artifactId)));
		const laterUpgrades = upgradeTodosFor(upgrades, new Set(plan.later.map((change) => change.artifactId)));
		const partial = buildPartialEquipTodos(plan, label, nowReasons, laterReasons);
		if (partial && partial.length >= 2) {
			const [nowTodo, ...rest] = partial;
			return {
				immediate: nowTodo ? [...nowUpgrades, nowTodo] : nowUpgrades,
				later: [...laterUpgrades, ...rest]
			};
		}
		if (partial) return {
			immediate: [...nowUpgrades, ...partial],
			later: laterUpgrades
		};
		if (isLocked) {
			const laterLabel = plan.laterNames.length > 0 ? plan.laterNames.join(" + ") : label;
			return {
				immediate: nowUpgrades,
				later: [...laterUpgrades, buildEquipTodo({
					headline: `Equip in ${formatMs(swapWaitMs)}`,
					loadout: laterLabel,
					reasons: laterReasons,
					urgency: {
						kind: "schedule",
						readyAtMs: swapWaitMs,
						durationMs: 0,
						chain: "equip"
					}
				})]
			};
		}
		return {
			immediate: [...nowUpgrades, buildEquipTodo({
				headline: beforeSwapCount > 0 ? "Then equip" : "Equip this set",
				loadout: label,
				reasons: laterReasons,
				urgency: {
					kind: "action",
					readyAtMs: 0,
					durationMs: 0,
					chain: "equip"
				}
			})],
			later: laterUpgrades
		};
	}
	function pushEquipPlanTodos(todos, options) {
		const { best, siteState, isMatchingLoadout, isLocked, waitMs, hasOwnedAllArp, hasAllArpEquipped, upgrades } = options;
		if (best && isMatchingLoadout) {
			const equippedIds = new Set(best.artifacts.map((artifact) => artifact.instanceId));
			todos.push(...upgradeTodosFor(upgrades, equippedIds));
			return;
		}
		const event = siteState.communityEvent;
		const pending = event && canEarnCommunityEventArp(event) ? breakDownCommunityEventPending(event) : void 0;
		if (hasOwnedAllArp && !hasAllArpEquipped && isLocked && pending && pending.waitingPersonalArp > 0) {
			todos.push({
				tone: "warn",
				text: `Slots on cooldown (${formatMs(waitMs)} left)`,
				reasons: [{ text: `Equip All-ARP% before playing Community Event hours (${formatCommunityEventArp(pending.waitingPersonalArp)} community-unlocked)` }],
				urgency: {
					kind: "schedule",
					readyAtMs: waitMs,
					durationMs: 0,
					arp: pending.waitingPersonalArp,
					chain: "equip"
				}
			});
			return;
		}
		if (hasOwnedAllArp && !hasAllArpEquipped && isLocked && pending && event && pending.waitingCommunityArp > 0) todos.push({
			tone: "muted",
			text: `Slots on cooldown (${formatMs(waitMs)} left)`,
			reasons: [{ text: `Consider All-ARP% before community unlock (${describeWaitingCommunityArpLine(event, pending.waitingCommunityArp)})` }],
			urgency: {
				kind: "info",
				readyAtMs: waitMs,
				durationMs: 0,
				arp: pending.waitingCommunityArp
			}
		});
	}
	function upgradeTodosFor(upgrades, instanceIds) {
		const todos = [];
		const seenAffordable = new Set();
		for (const upgrade of upgrades) {
			if (!upgrade.isAffordable) break;
			const instanceId = upgrade.artifact.instanceId;
			if (!instanceIds.has(instanceId)) continue;
			const todo = {
				text: `Upgrade ${upgrade.artifact.displayName} to ${TIER_LABELS[upgrade.toTier]} (${upgrade.fragmentCost} frag)`,
				urgency: {
					kind: "action",
					readyAtMs: 0,
					durationMs: 0,
					chain: "equip"
				}
			};
			if (!seenAffordable.has(instanceId)) {
				seenAffordable.add(instanceId);
				todo.upgradeInstanceId = instanceId;
			}
			todos.push(todo);
		}
		return todos;
	}
	function isImmediateDiscordUpgrade(plan, best) {
		return plan.now.some((change) => {
			const owned = best.artifacts.find((artifact) => artifact.instanceId === change.artifactId);
			const definition = owned ? getArtifactById(owned.familyId) : void 0;
			return definition?.effectType === ArtifactEffectType.DiscordPoll || definition?.effectType === ArtifactEffectType.AllArpPct;
		});
	}
	function discordPollSlot(options) {
		const { needsSwap, waitMs, nextPostMs, isPollBetterAfterSwap, canNowEquipHelpPoll } = options;
		if (needsSwap && isPollBetterAfterSwap && waitMs > 0 && waitMs < nextPostMs) return "afterFull";
		if (needsSwap && canNowEquipHelpPoll) return "afterNow";
		if (needsSwap && isPollBetterAfterSwap) return "before";
		return "other";
	}
	function discordPollTodoText(options) {
		const { slot, bonus, waitMs, nextPostMs, nowNames } = options;
		const bonusPart = bonus > 0 ? ` (+${bonus} equipped bonus)` : "";
		const nextPost = formatMs(nextPostMs);
		if (slot === "afterFull") return `Vote Discord Poll after unlock (${formatMs(waitMs)} wait, next post in ${nextPost})${bonusPart}`;
		if (slot === "afterNow") return `Vote Discord Poll after equipping ${nowNames}${bonusPart}`;
		if (slot === "before") return `Vote Discord Poll now — next post in ${nextPost}${bonusPart}`;
		if (bonus > 0) return `Vote Discord Poll (+${bonus} already equipped)`;
		return "Vote Discord Poll";
	}
	function buildDiscordPollAction(options) {
		const { result, settings, siteState, needsSwap, waitMs } = options;
		if (!isActivityEnabled(settings, "discordPoll")) return;
		if (hasVotedCurrentDiscordPoll(siteState.arpLog) || !isActivityAvailable(siteState.caps, "discordPoll")) return;
		const nextPostMs = msUntilNextDiscordPollPost();
		const current = result.current;
		const best = result.best;
		const isPollBetterAfterSwap = activityWindowArp(best, "discordPoll") > activityWindowArp(current, "discordPoll");
		const plan = best === void 0 ? void 0 : planLoadoutChanges(best.artifacts, current, settings, result.slotLocks);
		const slot = discordPollSlot({
			needsSwap,
			waitMs,
			nextPostMs,
			isPollBetterAfterSwap,
			canNowEquipHelpPoll: Boolean(best && plan && isImmediateDiscordUpgrade(plan, best))
		});
		const currentBonus = comboBonusForActivity(current, "discordPoll");
		const bestBonus = comboBonusForActivity(best, "discordPoll");
		let phase = "other";
		if (slot === "afterFull" || slot === "afterNow") phase = "after";
		else if (slot === "before") phase = "before";
		const bonus = slot === "other" ? currentBonus : bonusForActivityPhase(phase, currentBonus, bestBonus);
		const chain = slot === "afterFull" || slot === "afterNow" ? "after" : "before";
		const todo = {
			text: discordPollTodoText({
				slot,
				bonus,
				waitMs,
				nextPostMs,
				nowNames: plan?.now.map((change) => change.displayName).join(" + ") ?? ""
			}),
			urgency: actionUrgency({
				kind: "action",
				readyAtMs: slot === "afterFull" ? waitMs : 0,
				durationMs: 0,
				deadlineMs: nextPostMs,
				arp: BASE_ACTIVITY.discordPollBase + bonus,
				chain
			})
		};
		if (slot !== "afterFull" && nextPostMs <= 72e5) todo.tone = "warn";
		return {
			slot,
			todo
		};
	}
	function discordTodoForSlot(discord, slot) {
		return discord?.slot === slot ? [discord.todo] : [];
	}
	function pushRecommendedSwapTodos(options) {
		const { todos, best, current, settings, siteState, slotLocks, isLocked, waitMs, sequenced, discord, upgrades } = options;
		const swap = buildSwapEquipTodos({
			best,
			current,
			settings,
			siteState,
			isLocked,
			waitMs,
			beforeSwapCount: sequenced.beforeSwap.length + (discord?.slot === "before" ? 1 : 0),
			upgrades,
			...slotLocks && { slotLocks }
		});
		todos.push(...swap.immediate, ...sequenced.afterNow, ...discordTodoForSlot(discord, "afterNow"), ...sequenced.other, ...discordTodoForSlot(discord, "other"), ...swap.later);
	}
	function pushAfterSwapTodos(todos, sequenced, discord, isNeedsSwap) {
		const afterSwap = [...sequenced.afterSwap];
		if (discord?.slot === "afterFull") afterSwap.unshift(discord.todo);
		todos.push(...afterSwap);
		if (!isNeedsSwap) todos.push(...sequenced.other, ...discordTodoForSlot(discord, "other"));
	}
	function buildActionPlan(result, settings, siteState) {
		const todos = [];
		const best = result.best;
		const current = result.current;
		const isMatchingLoadout = isSameLoadout(best?.artifacts, current?.artifacts);
		const isLocked = hasAnySlotOnCooldown(current, result.slotLocks);
		const plan = best ? planLoadoutChanges(best.artifacts, current, settings, result.slotLocks) : void 0;
		const waitMs = plan?.waitMs ?? maxSlotCooldownMs(settings, current, result.slotLocks);
		const isNeedsSwap = Boolean(best && !isMatchingLoadout);
		const hasAllArpEquipped = result.hasAllArpEquipped === true || (current?.allArpPct ?? 0) > 0;
		const hasOwnedAllArp = result.hasAllArpOwned === true || hasAllArpEquipped || (result.allArpLoadout?.allArpPct ?? 0) > 0 || (best?.allArpPct ?? 0) > 0 || result.alternatives.some((combo) => combo.allArpPct > 0);
		const shouldDeferBattlePassClaim = result.deferBattlePassClaims === true;
		const hasPlannedAllArp = (best?.allArpPct ?? 0) > 0;
		const deferredAllArp = result.deferredAllArp;
		const allArpSchedule = battlePassAllArpSchedule({
			result,
			plan,
			isNeedsSwap,
			settings,
			waitMs,
			hasPlannedAllArp,
			shouldDeferBattlePassClaim
		});
		const hasScheduledAllArp = allArpSchedule.hasScheduledAllArp;
		const allArpEquipReadyAtMs = allArpSchedule.readyAtMs;
		const sequenced = buildSequencedActivityTodos(result, settings, siteState, {
			needsSwap: isNeedsSwap,
			waitMs
		});
		const discord = buildDiscordPollAction({
			result,
			settings,
			siteState,
			needsSwap: isNeedsSwap,
			waitMs
		});
		todos.push(...sequenced.beforeSwap);
		if (discord?.slot === "before") todos.push(discord.todo);
		if (best && isNeedsSwap) pushRecommendedSwapTodos({
			todos,
			best,
			current,
			settings,
			siteState,
			isLocked,
			waitMs,
			sequenced,
			discord,
			upgrades: result.upgrades,
			...result.slotLocks && { slotLocks: result.slotLocks }
		});
		else pushEquipPlanTodos(todos, {
			best,
			siteState,
			isMatchingLoadout,
			isLocked,
			waitMs,
			hasOwnedAllArp,
			hasAllArpEquipped,
			upgrades: result.upgrades
		});
		pushAllArpGuardTodos(todos, siteState, {
			ownsAllArp: hasOwnedAllArp,
			hasAllArpEquipped,
			isLocked,
			deferBattlePassClaims: shouldDeferBattlePassClaim,
			hasPlannedAllArp,
			hasDeferredAllArp: deferredAllArp !== void 0,
			hasScheduledAllArp
		});
		if (result.deferredSteam) todos.push(deferredSteamTodo(result.deferredSteam, siteState));
		if (shouldDeferBattlePassClaim) pushBattlePassTodo(todos, siteState, {
			ownsAllArp: hasOwnedAllArp,
			hasAllArpEquipped: false,
			afterAllArpEquipped: hasScheduledAllArp,
			allArpReadyAtMs: allArpEquipReadyAtMs
		});
		else pushBattlePassTodo(todos, siteState, {
			ownsAllArp: hasOwnedAllArp,
			hasAllArpEquipped,
			seasonEndsBeforeAllArp: hasOwnedAllArp && !hasAllArpEquipped
		});
		pushAfterSwapTodos(todos, sequenced, discord, isNeedsSwap);
		pushScheduledAllArpTodos(todos, result, settings, siteState, plan, isNeedsSwap, allArpSchedule.shouldAddEquipTodo);
		if (todos.length === 0) return [{
			tone: "muted",
			text: "Nothing urgent — check back after activities refresh",
			urgency: {
				kind: "info",
				readyAtMs: 0,
				durationMs: 0
			}
		}];
		const cautions = todos.filter((todo) => isCautionTodo(todo));
		const steps = sortActionTodosByUrgency(todos.filter((todo) => !isCautionTodo(todo)));
		return [...cautions, ...steps];
	}
	function actionTodoToneClass(tone) {
		if (tone === "warn") return " ao-todo-warn";
		if (tone === "muted") return " ao-todo-muted";
		return "";
	}
	function renderActionTodoBody(todo) {
		const parts = [`<span class="ao-todo-headline">${wrapArtifactNames(todo.text)}</span>`];
		if (todo.loadout) parts.push(`<span class="ao-todo-loadout">${wrapArtifactNames(todo.loadout)}</span>`);
		if (todo.reasons && todo.reasons.length > 0) {
			const items = todo.reasons.map((reason) => {
				const detail = reason.detail ? `<div class="ao-todo-reason-detail">${wrapArtifactNames(reason.detail)}</div>` : "";
				return `<li><div class="ao-todo-reason-text">${wrapArtifactNames(reason.text)}</div>${detail}</li>`;
			}).join("");
			parts.push(`<ul class="ao-todo-reasons">${items}</ul>`);
		}
		return parts.join("");
	}
	function renderTodoActionButton(todo, options = {}) {
		const areActionsEnabled = options.allowAccountActions === true;
		if (todo.upgradeInstanceId !== void 0) {
			if (!areActionsEnabled) return "";
			return `<button type="button" class="ao-upgrade-btn" data-id="${todo.upgradeInstanceId}">Upgrade</button>`;
		}
		if (todo.claimBattlePass === true) {
			if (!areActionsEnabled) return "";
			return `<button type="button" class="ao-claim-btn"${todo.claimBattlePassSkipArp === true ? " data-skip-arp=\"1\"" : ""}>${battlePassClaimButtonLabel(todo.claimBattlePassSkipArp === true)}</button>`;
		}
		if (todo.openTwitchStream === true) return "<button type=\"button\" class=\"ao-twitch-btn\">Open stream</button>";
		return "";
	}
	function isCautionTodo(todo) {
		return todo.kind === "caution";
	}
	function isKeepingCurrentLoadout(todos) {
		return todos.find((todo) => !isCautionTodo(todo))?.urgency?.chain !== "equip";
	}
	function renderActionPlanContents(todos, options = {}) {
		const cautions = todos.filter((todo) => isCautionTodo(todo));
		const steps = todos.filter((todo) => !isCautionTodo(todo));
		const cautionHtml = cautions.map((todo) => {
			return `<div class="ao-caution${actionTodoToneClass(todo.tone)}" role="note">${renderActionTodoBody(todo)}</div>`;
		}).join("");
		const items = steps.map((todo, index) => {
			return `<li class="ao-todo-item${actionTodoToneClass(todo.tone)}"><span class="ao-todo-index">${index + 1}.</span><div class="ao-todo-text">${renderActionTodoBody(todo)}</div>${renderTodoActionButton(todo, options)}</li>`;
		}).join("");
		return `
    <div class="ao-heading">What to do</div>
    ${cautionHtml}
    ${steps.length > 0 ? `<ul class="ao-todo-list">${items}</ul>` : ""}
  `;
	}
	function renderActionPlan(todos, options = {}) {
		return `<div id="ao-action-plan">${renderActionPlanContents(todos, options)}</div>`;
	}
	var OFFICIAL_GIVEAWAYS_PATH = "/ucf/Giveaway";
	var ESI_GIVEAWAY_PATH = "/esi/featured-tile-data/Giveaway";
	var MAX_ESI_PAGES = 10;
	var SHOW_GIVEAWAY_HREF = /\/ucf\/show\/(\d+)\/(?:[\w.-]+\/)*Giveaway\/([\w.-]+)/i;
	var LISTING_PATH = /\/ucf\/Giveaway\/?$/i;
	var IFRAME_WAIT_MS = 15e3;
	var IFRAME_SETTLE_MS = 600;
	function delay$1(ms) {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}
	function titleFromSlug(slug) {
		const words = slug.replaceAll("-", " ").trim();
		if (!words) return "New giveaway";
		return words.replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
	}
	function titleFromCard(element) {
		const headingText = element.querySelector("h1, h2, h3, h4, .giveaways__listing-post-title, .post-title, .tile-title")?.textContent?.replaceAll(/\s+/g, " ").trim();
		if (headingText) return headingText;
		const titled = element.title.trim();
		if (titled) return titled;
		return "";
	}
	function giveawayFromHref(href, title) {
		const match = SHOW_GIVEAWAY_HREF.exec(href);
		if (!match?.[1] || !match[2]) return;
		const id = match[1];
		const slug = match[2];
		return {
			id,
			title: title || titleFromSlug(slug),
			url: new URL(`/ucf/show/${id}/Giveaway/${slug}`, location.origin).href
		};
	}
	function addGiveaway(found, href, title) {
		const giveaway = giveawayFromHref(href, title);
		if (!giveaway) return;
		const existing = found.get(giveaway.id);
		if (!existing || giveaway.title.length > existing.title.length) found.set(giveaway.id, giveaway);
	}
	function withClaimed(giveaway, isClaimed) {
		if (isClaimed !== true) return giveaway;
		return {
			...giveaway,
			isClaimed: true
		};
	}
	function mergeGiveaways(groups) {
		const found = new Map();
		for (const group of groups) for (const giveaway of group) {
			const existing = found.get(giveaway.id);
			const isClaimed = existing?.isClaimed === true || giveaway.isClaimed === true;
			if (!existing || giveaway.title.length > existing.title.length) found.set(giveaway.id, withClaimed(giveaway, isClaimed));
			else if (isClaimed) found.set(giveaway.id, withClaimed(existing, true));
		}
		return found.values().toArray();
	}
	function isOfficialGiveawayListingPath(path) {
		return LISTING_PATH.test(path);
	}
	function scrapeGiveawayFromPath(pathOrUrl, title = "") {
		return giveawayFromHref(pathOrUrl, title);
	}
	function scrapeOfficialGiveawaysFromDocument(document_) {
		const found = new Map();
		for (const post of document_.querySelectorAll(".giveaways__listing-post, [data-url-link*=\"/ucf/show/\"]")) addGiveaway(found, post.dataset.urlLink ?? "", titleFromCard(post));
		for (const link of document_.querySelectorAll("a[href*=\"/ucf/show/\"][href*=\"/Giveaway/\"]")) addGiveaway(found, link.href, link.textContent?.replaceAll(/\s+/g, " ").trim() ?? "");
		const hrefMatches = (document_.documentElement?.getHTML() ?? "").matchAll(new RegExp(SHOW_GIVEAWAY_HREF.source, "gi"));
		for (const match of hrefMatches) if (match[0]) addGiveaway(found, match[0], "");
		return found.values().toArray();
	}
	function scrapeLiveGiveaways() {
		const listing = isOfficialGiveawayListingPath(location.pathname) ? scrapeOfficialGiveawaysFromDocument(document) : [];
		const pageTitle = document.querySelector("h1, .ucf-title, .content-title")?.textContent?.replaceAll(/\s+/g, " ").trim() ?? document.title.split("|", 1)[0]?.trim() ?? "";
		const current = scrapeGiveawayFromPath(location.pathname, pageTitle);
		return mergeGiveaways([listing, current ? [current] : []]);
	}
	function esiItemsFromPayload(data) {
		if (Array.isArray(data)) return data;
		if (typeof data === "object" && data && "data" in data) {
			const nested = data.data;
			if (Array.isArray(nested)) return nested;
		}
		return [];
	}
	function officialGiveawayFromEsi(item) {
		if (item.id === void 0) return;
		const id = String(item.id);
		const title = (item.title ?? item.name ?? "").trim() || titleFromSlug(item.slug ?? "");
		let url;
		if (item.url) url = new URL(item.url, location.origin).href;
		else if (item.slug) url = new URL(`/ucf/show/${id}/Giveaway/${item.slug}`, location.origin).href;
		else url = new URL(`/ucf/show/${id}/`, location.origin).href;
		const giveaway = {
			id,
			title,
			url
		};
		if (giveawayKeyStatus(id)?.status === "assigned") giveaway.isClaimed = true;
		return giveaway;
	}
	async function fetchEsiGiveawayPage(page) {
		const response = await fetch(`${ESI_GIVEAWAY_PATH}/${page}`, { headers: {
			Accept: "*/*",
			"X-Requested-With": "XMLHttpRequest"
		} });
		if (!response.ok) throw new Error(`ESI Giveaway page ${page} failed (${response.status})`);
		return esiItemsFromPayload(await response.json());
	}
	async function loadGiveawaysFromEsi() {
		const found = [];
		for (let page = 1; page <= MAX_ESI_PAGES; page += 1) {
			let items;
			try {
				items = await fetchEsiGiveawayPage(page);
			} catch (error) {
				if (page === 1) throw error;
				break;
			}
			if (items.length === 0) break;
			for (const item of items) {
				const giveaway = officialGiveawayFromEsi(item);
				if (giveaway) found.push(giveaway);
			}
		}
		return mergeGiveaways([found]);
	}
	async function fetchGiveawayDocument(path) {
		try {
			const response = await fetch(path, { headers: { Accept: "text/html" } });
			if (!response.ok) return;
			const html = await response.text();
			return new DOMParser().parseFromString(html, "text/html");
		} catch (error) {
			console.warn("[AWA Toolkit] Giveaway listing fetch failed:", error);
			return;
		}
	}
	async function openGiveawayListingFrame() {
		return new Promise((resolve) => {
			const iframe = document.createElement("iframe");
			iframe.setAttribute("aria-hidden", "true");
			iframe.style.cssText = "position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none;border:0";
			const cleanup = () => {
				iframe.remove();
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve(void 0);
			}, IFRAME_WAIT_MS);
			iframe.addEventListener("load", () => {
				clearTimeout(timer);
				delay$1(IFRAME_SETTLE_MS).then(() => {
					const document_ = iframe.contentDocument ?? void 0;
					cleanup();
					resolve(document_);
				});
			});
			iframe.addEventListener("error", () => {
				clearTimeout(timer);
				cleanup();
				resolve(void 0);
			});
			document.body.append(iframe);
			iframe.src = OFFICIAL_GIVEAWAYS_PATH;
		});
	}
	async function loadOfficialGiveaways() {
		const live = scrapeLiveGiveaways();
		try {
			const fromEsi = await loadGiveawaysFromEsi();
			if (fromEsi.length > 0) return mergeGiveaways([fromEsi, live]);
		} catch (error) {
			console.warn("[AWA Toolkit] ESI giveaway list failed:", error);
		}
		if (isOfficialGiveawayListingPath(location.pathname) && live.length > 0) return live;
		const fetched = await fetchGiveawayDocument(OFFICIAL_GIVEAWAYS_PATH);
		const fromFetch = fetched ? scrapeOfficialGiveawaysFromDocument(fetched) : [];
		if (fromFetch.length > 0) return mergeGiveaways([fromFetch, live]);
		const framed = await openGiveawayListingFrame();
		return mergeGiveaways([framed ? scrapeOfficialGiveawaysFromDocument(framed) : [], live]);
	}
	var NOTIFY_LOG_KEY = "artifactOptimizerNotifyLog";
	var NOTIFY_ICON = "https://raw.githubusercontent.com/UpDownLeftDie/AWA-Toolkit/main/icon.png";
	var NOTIFY_TITLE = "AWA Toolkit";
	var FIRED_KEEP_MS = 1728e5;
	var ZOMBIE_MS = 864e5;
	var SHOWROOM_PATH = "/user-artifacts-room";
	var VAULT_PATH = "/game-vault";
	var CONTROL_CENTER_PATH$1 = "/control-center";
	function absoluteAwaUrl(pathOrUrl) {
		return new URL(pathOrUrl, location.origin).href;
	}
	function notifyUrlForKind(kind) {
		if (kind === "swap") return absoluteAwaUrl(SHOWROOM_PATH);
		if (kind === "vault") return absoluteAwaUrl(VAULT_PATH);
		if (kind === "giveaway") return absoluteAwaUrl(OFFICIAL_GIVEAWAYS_PATH);
		return absoluteAwaUrl(CONTROL_CENTER_PATH$1);
	}
	var pendingTimers = new Map();
	var notifyRuntime = {
		syncGeneration: 0,
		didBindWake: false,
		shouldForceGiveawayCheck: false
	};
	function emptyLog() {
		return {
			scheduled: {},
			fired: {},
			seenGiveawayIds: [],
			seenVaultKeys: [],
			hasSeededGiveaways: false,
			hasSeededVaultItems: false
		};
	}
	function isRecord(value) {
		return typeof value === "object" && value !== null;
	}
	var NOTIFY_KINDS = [
		"swap",
		"vault",
		"community",
		"giveaway"
	];
	var GIVEAWAY_CHECK_MS = 9e5;
	var SEEN_GIVEAWAY_KEEP = 300;
	function isNotifyKind(value) {
		return typeof value === "string" && NOTIFY_KINDS.includes(value);
	}
	function optionalNumberIds(value) {
		if (!Array.isArray(value)) return;
		const ids = value.filter((id) => typeof id === "number");
		return ids.length > 0 ? ids : void 0;
	}
	function parseScheduledNotify(value) {
		if (!isRecord(value) || !isNotifyKind(value.kind)) return;
		if (typeof value.id !== "string" || typeof value.fireAt !== "number" || typeof value.title !== "string" || typeof value.body !== "string") return;
		const event = {
			id: value.id,
			kind: value.kind,
			fireAt: value.fireAt,
			title: value.title,
			body: value.body,
			url: typeof value.url === "string" && value.url ? value.url : notifyUrlForKind(value.kind)
		};
		const artifactIds = optionalNumberIds(value.artifactIds);
		if (artifactIds) event.artifactIds = artifactIds;
		if (typeof value.cycleId === "string" && value.cycleId) event.cycleId = value.cycleId;
		if (typeof value.targetHours === "number") event.targetHours = value.targetHours;
		return event;
	}
	function scheduledFromUnknown(value) {
		if (!isRecord(value)) return {};
		const scheduled = {};
		for (const [id, item] of Object.entries(value)) {
			const event = parseScheduledNotify(item);
			if (event) scheduled[id] = event;
		}
		return scheduled;
	}
	function stringListFromUnknown(value) {
		if (!Array.isArray(value)) return [];
		return value.filter((item) => typeof item === "string" && item.length > 0);
	}
	function notifyLogFromUnknown(value) {
		const log = {
			scheduled: scheduledFromUnknown(value.scheduled),
			fired: firedFromUnknown(value.fired),
			seenGiveawayIds: stringListFromUnknown(value.seenGiveawayIds),
			seenVaultKeys: stringListFromUnknown(value.seenVaultKeys),
			hasSeededGiveaways: value.hasSeededGiveaways === true,
			hasSeededVaultItems: value.hasSeededVaultItems === true
		};
		if (typeof value.lastGiveawayCheckAt === "number") log.lastGiveawayCheckAt = value.lastGiveawayCheckAt;
		return log;
	}
	function firedFromUnknown(value) {
		if (!isRecord(value)) return {};
		const fired = {};
		for (const [id, at] of Object.entries(value)) if (typeof at === "number") fired[id] = at;
		return fired;
	}
	async function loadNotifyLog() {
		const raw = await _GM.getValue(NOTIFY_LOG_KEY);
		if (!raw) return emptyLog();
		try {
			const parsedUnknown = typeof raw === "string" ? JSON.parse(raw) : raw;
			if (!isRecord(parsedUnknown)) return emptyLog();
			return notifyLogFromUnknown(parsedUnknown);
		} catch (error) {
			console.error("[AWA Toolkit] Error parsing notification log:", error);
			return emptyLog();
		}
	}
	async function saveNotifyLog(log) {
		await _GM.setValue(NOTIFY_LOG_KEY, JSON.stringify(log));
	}
	function pruneFired(log, now) {
		for (const [id, at] of Object.entries(log.fired)) if (now - at > FIRED_KEEP_MS) delete log.fired[id];
	}
	function clearPendingTimers() {
		for (const timer of pendingTimers.values()) clearTimeout(timer);
		pendingTimers.clear();
	}
	function onNotifyClick(event, url) {
		event?.preventDefault();
		window.focus();
		const path = new URL(url, location.origin).pathname;
		if (location.pathname !== path) location.assign(path);
	}
	function isNotificationPermissionGranted() {
		return typeof Notification !== "undefined" && Notification.permission === "granted";
	}
	function didShowWebNotification(options) {
		if (!isNotificationPermissionGranted()) return false;
		const notification = new Notification(options.title, {
			body: options.text,
			icon: NOTIFY_ICON,
			tag: options.tag,
			requireInteraction: true
		});
		notification.addEventListener("click", () => {
			onNotifyClick(void 0, options.url);
			notification.close();
		});
		return true;
	}
	function didShowGmNotification(options) {
		if (typeof _GM.notification !== "function") return false;
		try {
			_GM.notification({
				title: options.title,
				text: options.text,
				image: NOTIFY_ICON,
				tag: options.tag,
				url: options.url,
				highlight: true,
				zombieTimeout: ZOMBIE_MS,
				zombieUrl: options.url,
				onclick: (event) => {
					onNotifyClick(event, options.url);
				}
			});
			return true;
		} catch (error) {
			console.error("[AWA Toolkit] GM.notification failed:", error);
			return false;
		}
	}
	function didShowBrowserNotification(options) {
		if (didShowWebNotification(options)) return true;
		return didShowGmNotification(options);
	}
	function sortedIds(ids) {
		return [...ids].toSorted((left, right) => left - right);
	}
	function pendingSwapTarget(source) {
		const { result, settings } = source;
		const best = result.best;
		const current = result.current;
		if (best && !isSameLoadout(best.artifacts, current?.artifacts)) {
			const plan = planLoadoutChanges(best.artifacts, current, settings, result.slotLocks);
			if (plan.waitMs <= 0) return;
			const later = best.artifacts.filter((artifact) => plan.later.some((item) => item.artifactId === artifact.instanceId));
			return {
				artifacts: later.length > 0 ? later : best.artifacts,
				waitMs: plan.waitMs
			};
		}
		const deferred = result.deferredAllArp;
		if (!deferred || deferred.waitMs <= 0) return;
		return {
			artifacts: deferred.artifacts,
			waitMs: deferred.waitMs
		};
	}
	function swapNotifyEvent(source, now) {
		const pending = pendingSwapTarget(source);
		if (!pending) return;
		const ids = sortedIds(pending.artifacts.map((artifact) => artifact.instanceId));
		const event = {
			id: `swap:${ids.join(",")}`,
			kind: "swap",
			fireAt: now + pending.waitMs,
			title: "Recommended swap ready",
			body: `You can equip ${loadoutLabel(pending.artifacts)} now.`,
			url: notifyUrlForKind("swap")
		};
		if (ids.length > 0) event.artifactIds = ids;
		return event;
	}
	function notifyTypeKeyForKind(kind) {
		return kind === "giveaway" ? "giveaways" : kind;
	}
	function isKindEnabled(source, kind) {
		return isNotificationTypeEnabled(source.settings, notifyTypeKeyForKind(kind));
	}
	function vaultNotifyEvent(source, now) {
		const cycleId = gameVaultCycleId(source.siteState);
		const opensAt = gameVaultOpensAtMs(source.siteState);
		if (!cycleId || opensAt === void 0 || opensAt <= now) return;
		return {
			id: `vault:${cycleId}`,
			kind: "vault",
			fireAt: opensAt,
			title: "Game Vault is open",
			body: "The monthly Game Vault window is live.",
			url: notifyUrlForKind("vault"),
			cycleId
		};
	}
	function communityNotifyEvent(source, now) {
		const community = source.siteState.communityEvent;
		if (!community || !canEarnCommunityEventArp(community)) return;
		const pending = breakDownCommunityEventPending(community);
		const eta = estimateNextCommunityUnlock(community, now);
		if (!eta || eta.etaMs <= 0 || pending.waitingCommunityArp <= 0) return;
		return {
			id: `community:${eta.targetHours}`,
			kind: "community",
			fireAt: now + eta.etaMs,
			title: "Community Event unlock",
			body: `${formatCommunityEventArp(pending.waitingCommunityArp)} should unlock around now.`,
			url: community.url ? absoluteAwaUrl(community.url) : notifyUrlForKind("community"),
			targetHours: eta.targetHours
		};
	}
	function collectUpcomingEvents(source, now) {
		const events = [];
		if (isKindEnabled(source, "swap")) events.push(swapNotifyEvent(source, now));
		if (isKindEnabled(source, "vault")) events.push(vaultNotifyEvent(source, now));
		if (isKindEnabled(source, "community")) events.push(communityNotifyEvent(source, now));
		return events.filter((event) => event !== void 0);
	}
	function vaultItemKey(game) {
		return `${game.name}:${game.price}`;
	}
	function collectNewVaultItems(source, log, now) {
		const games = source.siteState.gameVault.filter((game) => game.inStock && game.isAuction !== true);
		if (games.length === 0) return [];
		const keys = games.map((game) => vaultItemKey(game));
		if (!log.hasSeededVaultItems) {
			log.seenVaultKeys = [...new Set([...log.seenVaultKeys, ...keys])];
			log.hasSeededVaultItems = true;
			return [];
		}
		const seen = new Set(log.seenVaultKeys);
		const events = [];
		for (const game of games) {
			const key = vaultItemKey(game);
			if (seen.has(key)) continue;
			seen.add(key);
			events.push({
				id: `vault-item:${key}`,
				kind: "vault",
				fireAt: now,
				title: "New Game Vault item",
				body: game.name,
				url: notifyUrlForKind("vault")
			});
		}
		log.seenVaultKeys = [...seen];
		return events;
	}
	function pruneSeenIds(ids, keep, max) {
		const keepSet = new Set(keep);
		const extras = ids.filter((id) => !keepSet.has(id));
		const extraBudget = Math.max(0, max - keep.length);
		return [...keep, ...extras.slice(-extraBudget)];
	}
	function isGiveawayCheckDue(log, now) {
		if (notifyRuntime.shouldForceGiveawayCheck || !log.hasSeededGiveaways) return true;
		if (log.lastGiveawayCheckAt === void 0) return true;
		return now - log.lastGiveawayCheckAt >= GIVEAWAY_CHECK_MS;
	}
	async function collectNewGiveaways(log, now) {
		const shouldCheck = isGiveawayCheckDue(log, now);
		notifyRuntime.shouldForceGiveawayCheck = false;
		if (!shouldCheck) return [];
		const posts = await loadOfficialGiveaways();
		log.lastGiveawayCheckAt = now;
		if (posts.length === 0) return [];
		const postIds = posts.map((post) => post.id);
		if (!log.hasSeededGiveaways) {
			log.seenGiveawayIds = [...new Set([...log.seenGiveawayIds, ...postIds])];
			log.hasSeededGiveaways = true;
			return [];
		}
		const seen = new Set(log.seenGiveawayIds);
		const events = [];
		for (const post of posts) {
			if (seen.has(post.id)) continue;
			seen.add(post.id);
			if (post.isClaimed === true) continue;
			events.push({
				id: `giveaway:${post.id}`,
				kind: "giveaway",
				fireAt: now,
				title: "New giveaway",
				body: post.title,
				url: post.url
			});
		}
		log.seenGiveawayIds = pruneSeenIds([...seen], postIds, SEEN_GIVEAWAY_KEEP);
		return events;
	}
	function isSwapStillRelevant(event, source) {
		const best = source.result.best;
		const current = source.result.current;
		if (!best || isSameLoadout(best.artifacts, current?.artifacts)) return false;
		if (!event.artifactIds || event.artifactIds.length === 0) return true;
		const bestIds = new Set(best.artifacts.map((artifact) => artifact.instanceId));
		return event.artifactIds.some((id) => bestIds.has(id));
	}
	function isCommunityStillRelevant(source) {
		const community = source.siteState.communityEvent;
		if (!community || !canEarnCommunityEventArp(community)) return false;
		const pending = breakDownCommunityEventPending(community);
		return pending.waitingCommunityArp > 0 || pending.imminentArp > 0;
	}
	function isVaultStillRelevant(event, source) {
		if (event.id.startsWith("vault-item:")) return true;
		return gameVaultOpensAtMs(source.siteState) !== void 0;
	}
	function isEventStillRelevant(event, source) {
		if (!isKindEnabled(source, event.kind)) return false;
		if (event.kind === "swap") return isSwapStillRelevant(event, source);
		if (event.kind === "vault") return isVaultStillRelevant(event, source);
		if (event.kind === "community") return isCommunityStillRelevant(source);
		return true;
	}
	function mergeUpcomingIntoLog(log, upcoming, source, now) {
		const upcomingIds = new Set(upcoming.map((event) => event.id));
		for (const event of upcoming) log.scheduled[event.id] = event;
		for (const [id, event] of Object.entries(log.scheduled)) {
			if (upcomingIds.has(id)) continue;
			if (isEventStillRelevant(event, source)) {
				event.fireAt = Math.min(event.fireAt, now);
				continue;
			}
			delete log.scheduled[id];
		}
	}
	async function didFireDueEvents(log, source, generation, now) {
		for (const [id, event] of Object.entries(log.scheduled)) {
			if (event.fireAt > now) continue;
			if (log.fired[id] !== void 0 || !isEventStillRelevant(event, source)) {
				delete log.scheduled[id];
				continue;
			}
			if (generation !== notifyRuntime.syncGeneration) return false;
			if (didShowBrowserNotification({
				title: event.title,
				text: event.body,
				tag: event.id,
				url: event.url
			})) log.fired[id] = Date.now();
			delete log.scheduled[id];
		}
		return true;
	}
	function armTimers(log) {
		clearPendingTimers();
		const now = Date.now();
		for (const event of Object.values(log.scheduled)) {
			const delay = Math.max(0, event.fireAt - now);
			pendingTimers.set(event.id, setTimeout(() => {
				pendingTimers.delete(event.id);
				const source = notifyRuntime.lastSource;
				if (!source) return;
				syncBrowserNotifications(source);
			}, delay));
		}
	}
	function clearGiveawayPoll() {
		if (notifyRuntime.giveawayPollId === void 0) return;
		clearInterval(notifyRuntime.giveawayPollId);
		delete notifyRuntime.giveawayPollId;
	}
	function armGiveawayPoll() {
		if (notifyRuntime.giveawayPollId !== void 0) return;
		notifyRuntime.giveawayPollId = setInterval(() => {
			const source = notifyRuntime.lastSource;
			if (!source?.settings.browserNotifications) return;
			if (!isNotificationTypeEnabled(source.settings, "giveaways")) return;
			syncBrowserNotifications(source);
		}, GIVEAWAY_CHECK_MS);
	}
	function wakeScheduledNotifications() {
		const source = notifyRuntime.lastSource;
		if (!source?.settings.browserNotifications) return;
		syncBrowserNotifications(source);
	}
	function bindWakeListeners() {
		if (notifyRuntime.didBindWake) return;
		notifyRuntime.didBindWake = true;
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") wakeScheduledNotifications();
		});
		window.addEventListener("focus", wakeScheduledNotifications);
	}
	function sourceWithNotificationsOn(source) {
		return {
			...source,
			settings: {
				...source.settings,
				browserNotifications: true
			}
		};
	}
	async function syncBrowserNotifications(source) {
		notifyRuntime.syncGeneration += 1;
		if (!source.settings.browserNotifications) {
			clearPendingTimers();
			clearGiveawayPoll();
			return;
		}
		const generation = notifyRuntime.syncGeneration;
		bindWakeListeners();
		armGiveawayPoll();
		const now = Date.now();
		const log = await loadNotifyLog();
		if (generation !== notifyRuntime.syncGeneration) return;
		const upcoming = collectUpcomingEvents(source, now);
		if (isKindEnabled(source, "vault")) upcoming.push(...collectNewVaultItems(source, log, now));
		if (isKindEnabled(source, "giveaway")) upcoming.push(...await collectNewGiveaways(log, now));
		if (generation !== notifyRuntime.syncGeneration) return;
		mergeUpcomingIntoLog(log, upcoming, source, now);
		if (!await didFireDueEvents(log, source, generation, now)) return;
		pruneFired(log, Date.now());
		await saveNotifyLog(log);
		if (generation !== notifyRuntime.syncGeneration) return;
		armTimers(log);
	}
	function scheduleBrowserNotifications(source) {
		notifyRuntime.lastSource = source;
		syncBrowserNotifications(source);
	}
	async function didGrantWebNotificationPermission() {
		if (typeof Notification === "undefined") return typeof _GM.notification === "function";
		if (Notification.permission === "granted") return true;
		if (Notification.permission === "denied") return false;
		return await Notification.requestPermission() === "granted";
	}
	async function didDisableBrowserNotifications() {
		clearPendingTimers();
		clearGiveawayPoll();
		await saveArtifactSettings({ browserNotifications: false });
		const previous = notifyRuntime.lastSource;
		if (previous) notifyRuntime.lastSource = {
			...previous,
			settings: {
				...previous.settings,
				browserNotifications: false
			}
		};
		return true;
	}
	async function didSetBrowserNotifications(isEnabled, source) {
		if (!isEnabled) return didDisableBrowserNotifications();
		if (!await didGrantWebNotificationPermission()) return false;
		if (!didShowBrowserNotification({
			title: NOTIFY_TITLE,
			text: "Notifications are on. Use the switches below to choose recommended swap, community, Game Vault, and new giveaways.",
			tag: "awa-toolkit-test",
			url: notifyUrlForKind("community")
		})) return false;
		await saveArtifactSettings({ browserNotifications: true });
		const nextSource = source ?? notifyRuntime.lastSource;
		if (nextSource) {
			notifyRuntime.lastSource = sourceWithNotificationsOn(nextSource);
			if (isNotificationTypeEnabled(nextSource.settings, "giveaways")) notifyRuntime.shouldForceGiveawayCheck = true;
			scheduleBrowserNotifications(notifyRuntime.lastSource);
		}
		return true;
	}
	async function saveNotificationType(key, isEnabled) {
		const notificationTypes = {
			...(await getArtifactSettings()).notificationTypes,
			[key]: isEnabled
		};
		await saveArtifactSettings({ notificationTypes });
		if (key === "giveaways" && isEnabled) notifyRuntime.shouldForceGiveawayCheck = true;
		const previous = notifyRuntime.lastSource;
		if (!previous) return;
		notifyRuntime.lastSource = {
			...previous,
			settings: {
				...previous.settings,
				notificationTypes
			}
		};
		scheduleBrowserNotifications(notifyRuntime.lastSource);
	}
	var STALE_MS = 216e5;
	var SLOT_LOCK_STALE_MS = 3e5;
	var ARP_LOG_STALE_MS = 216e5;
	var FORCE_REFRESH_COOLDOWN_MS = 5e3;
	var EQUIP_CONFIRM_RETRY_MS = 750;
	var BATTLE_PASS_STALE_MS = 36e5;
	var COMMUNITY_EVENT_PENDING_STALE_MS = STALE_MS;
	var CONTROL_CENTER_PATH = "/control-center";
	var BATTLE_PASS_PATH = "/control-center/battle-pass/1";
	var GAME_VAULT_PATH = "/marketplace/game-vault";
	var ARP_LOG_PATH = "/account/arp-log";
	var QUEST_SETUP_PATH = "/steam/questsetup";
	var ARP_LOG_MAX_ROWS = 300;
	var ARP_LOG_DEFAULT_DAYS = 7;
	var ARP_LOG_LIVE_EVENT_DAYS = 14;
	function resolveArpLogPath(event) {
		const days = event?.isLive ? ARP_LOG_LIVE_EVENT_DAYS : ARP_LOG_DEFAULT_DAYS;
		const now = new Date();
		const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1e3);
		const toExclusive = new Date(now.getTime() + 864e5);
		return `${ARP_LOG_PATH}?from=${utcDateString(from)}&to=${utcDateString(toExclusive)}&max=${ARP_LOG_MAX_ROWS}`;
	}
	function pathnameFromUrl(url, fallback) {
		try {
			return new URL(url, location.origin).pathname;
		} catch {
			return fallback;
		}
	}
	async function fetchDocument(path) {
		try {
			const response = await fetch(path, { headers: { Accept: "text/html" } });
			if (!response.ok) {
				console.warn("[Artifact Optimizer] Failed to fetch", path, response.status);
				return;
			}
			const html = await response.text();
			return {
				document: new DOMParser().parseFromString(html, "text/html"),
				url: response.url || path
			};
		} catch (error) {
			console.warn("[Artifact Optimizer] Fetch error for", path, error);
			return;
		}
	}
	function delay(ms) {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	}
	async function waitForCommunityEventHours(document_) {
		const started = Date.now();
		while (Date.now() - started < 4e3) {
			if (document_.querySelector("#personal-hours")?.textContent?.trim()) break;
			await delay(250);
		}
	}
	async function settleIframePage(iframe, path) {
		const document_ = iframe.contentDocument ?? void 0;
		if (!document_) return;
		if (path.includes("/steam/community-event")) await waitForCommunityEventHours(document_);
		else if (path.includes("/battle-pass")) await waitForBattlePassUi(document_);
		else await delay(400);
		return {
			document: document_,
			url: iframe.contentWindow?.location.href ?? path
		};
	}
	async function openPageDocument(path) {
		return new Promise((resolve) => {
			const iframe = document.createElement("iframe");
			iframe.setAttribute("aria-hidden", "true");
			iframe.style.cssText = "position:fixed;width:1px;height:1px;left:-9999px;top:0;opacity:0;pointer-events:none;border:0";
			const cleanup = () => {
				iframe.remove();
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve(void 0);
			}, 15e3);
			iframe.addEventListener("load", () => {
				clearTimeout(timer);
				settleIframePage(iframe, path).then((page) => {
					cleanup();
					resolve(page);
				});
			});
			iframe.addEventListener("error", () => {
				clearTimeout(timer);
				cleanup();
				resolve(void 0);
			});
			document.body.append(iframe);
			iframe.src = path;
		});
	}
	async function waitForBattlePassUi(document_) {
		const started = Date.now();
		while (Date.now() - started < 5e3) {
			if (isBattlePassDocumentReady(document_)) return;
			await delay(250);
		}
	}
	function hasPersonalHours(document_) {
		const domHours = document_.querySelector("#personal-hours")?.textContent?.trim();
		if (domHours && /\d/.test(domHours)) return true;
		if (/Your Total Hours:\s*[\d.]+/i.test(document_.body?.textContent ?? "")) return true;
		const scripts = [...document_.querySelectorAll("script:not([src])")].map((script) => script.textContent ?? "").join("\n");
		return /personalPlaytime\s*=\s*\d+/i.test(scripts);
	}
	function requiresIframeFallback(path, fetched) {
		if (path.includes("/artifacts") || path.includes("/user-artifacts-room")) return !fetched.body?.querySelector(":scope a.artifact-list-item.change-artifact-modal, :scope .slot img");
		if (path.includes("/arp-log")) return !isArpLogDocumentReady(fetched);
		if (path.includes("/battle-pass")) return !isBattlePassDocumentReady(fetched);
		if (path.includes("/steam/community-event")) return !fetched.querySelector(".carousel-cell") || !hasPersonalHours(fetched);
		if (/\/steam\/quests\/.+/.test(path)) return !hasSteamPlayEligibilitySignal(fetched);
		return false;
	}
	function hasSteamPlayEligibilitySignal(document_) {
		if (document_.querySelector(".btn-check-owned-games, .btn-start-quest, .alert-steam, a[href^='steam://']")) return true;
		if ([...document_.querySelectorAll("a, button")].map((element) => (element.textContent ?? "").replaceAll(/\s+/g, " ").trim()).some((label) => /^(Check Game|Visit Steam|Sync Games|Launch Game)$/i.test(label))) return true;
		return /completed this quest/i.test(document_.body?.textContent ?? "");
	}
	async function loadRemotePage(path) {
		const fetched = await fetchDocument(path);
		if (fetched?.document.querySelector("a.artifact-list-item, body")) {
			if (requiresIframeFallback(path, fetched.document)) return openPageDocument(path);
			return fetched;
		}
		return openPageDocument(path);
	}
	async function loadRemoteDocument(path) {
		return (await loadRemotePage(path))?.document;
	}
	function isSnapshotFresh(snapshot) {
		if (!snapshot || snapshot.artifacts.length === 0) return false;
		if (!snapshot.slotLocks) return false;
		const scrapedAt = Date.parse(snapshot.scrapedAt);
		if (Number.isNaN(scrapedAt)) return false;
		return Date.now() - scrapedAt < STALE_MS;
	}
	function areSlotLocksFresh(snapshot) {
		if (!snapshot?.slotLocks) return false;
		return isScrapedWithin(snapshot.scrapedAt, SLOT_LOCK_STALE_MS);
	}
	function isCapsFresh(state, now = new Date()) {
		if (!state) return false;
		if (!isScrapedWithin(state.updatedAt, STALE_MS)) return false;
		if (!isScrapedSinceUtcMidnight(state.updatedAt, now)) return false;
		if (Object.values(state.caps).every((status) => status === "unknown")) return false;
		if (state.caps.steamQuests === "available" && (state.steamQuests?.quests.length ?? 0) === 0) return false;
		return true;
	}
	function shouldRescrapeBattlePass(state) {
		const bp = state?.battlePass;
		if (!bp || typeof bp.readyToClaimArp !== "number") return true;
		const scrapedAt = Date.parse(bp.scrapedAt ?? "");
		if (Number.isNaN(scrapedAt)) return true;
		return Date.now() - scrapedAt > BATTLE_PASS_STALE_MS;
	}
	async function refreshBattlePassOnly(next) {
		const battleDocument = await loadRemoteDocument(BATTLE_PASS_PATH);
		if (!battleDocument) return;
		const battlePass = scrapeBattlePassFromDocument(battleDocument);
		if (battlePass) next.battlePass = mergeBattlePassScrape(battlePass, next.battlePass);
	}
	function isScrapedWithin(scrapedAt, maxAgeMs) {
		if (!scrapedAt) return false;
		const at = Date.parse(scrapedAt);
		if (Number.isNaN(at)) return false;
		return Date.now() - at < maxAgeMs;
	}
	function utcDayStartMs(now = new Date()) {
		return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	}
	function isScrapedSinceUtcMidnight(scrapedAt, now = new Date()) {
		if (!scrapedAt) return false;
		const at = Date.parse(scrapedAt);
		if (Number.isNaN(at)) return false;
		return at >= utcDayStartMs(now);
	}
	function isArpLogFresh(state, now = new Date()) {
		const arpLog = state?.arpLog;
		if (!arpLog || arpLog.recent.length === 0) return false;
		const scrapedAt = arpLog.scrapedAt;
		if (!isScrapedWithin(scrapedAt, ARP_LOG_STALE_MS)) return false;
		if (!isScrapedSinceUtcMidnight(scrapedAt, now)) return false;
		return Date.parse(scrapedAt) >= lastDiscordPollPostAt(now).getTime();
	}
	function isCommunityEventFresh(state, now = new Date()) {
		const event = state?.communityEvent;
		if (!event?.isLive) {
			if (state?.caps.steamCommunityEvent === "available") return false;
			return isCapsFresh(state, now);
		}
		if (event.milestones.length === 0) return false;
		const ttl = event.pendingArp > 0 ? COMMUNITY_EVENT_PENDING_STALE_MS : STALE_MS;
		if (!isScrapedWithin(event.scrapedAt, ttl)) return false;
		return isScrapedSinceUtcMidnight(event.scrapedAt, now);
	}
	async function persistShowroomSnapshot(loaded, showroomPath, existing) {
		const snapshot = scrapeShowroomFromDocument(loaded.document, pathnameFromUrl(loaded.url, showroomPath));
		if (snapshot.artifacts.length > 0) {
			await saveSnapshot(snapshot);
			await syncSlotLocksFromScrape(snapshot.slotLocks ?? {});
			console.info("[Artifact Optimizer] Showroom locks", snapshot.slotLocks, "equipped", snapshot.artifacts.filter((artifact) => artifact.equippedPosition !== void 0).map((artifact) => ({
				slot: artifact.equippedPosition,
				name: artifact.displayName,
				locked: artifact.slotLocked === true
			})));
			return snapshot;
		}
		if (existing?.slotLocks) await syncSlotLocksFromScrape(existing.slotLocks);
		return existing;
	}
	async function scrapeShowroomAfterLockNudge(showroomPath, existing) {
		let inventory = existing;
		if (!inventory?.artifacts.length) {
			const prelim = await loadRemotePage(showroomPath);
			if (prelim) inventory = scrapeShowroomFromDocument(prelim.document, pathnameFromUrl(prelim.url, showroomPath));
		}
		if (inventory?.artifacts.length && areAccountActionsEnabled(await getArtifactSettings())) await nudgeStuckSlotLocks(inventory.artifacts);
		const loaded = await loadRemotePage(showroomPath);
		if (!loaded) {
			if (existing?.slotLocks) await syncSlotLocksFromScrape(existing.slotLocks);
			return existing;
		}
		return persistShowroomSnapshot(loaded, showroomPath, existing);
	}
	function hasSnapshotLoadout(snapshot, applied) {
		return applied.every((target) => snapshot.artifacts.some((artifact) => artifact.instanceId === target.artifactId && artifact.equippedPosition === target.position));
	}
	async function fetchShowroomSnapshot() {
		const showroomPath = resolveShowroomUrl((await loadSnapshot())?.username);
		const loaded = await loadRemotePage(showroomPath);
		if (!loaded) return;
		const snapshot = scrapeShowroomFromDocument(loaded.document, pathnameFromUrl(loaded.url, showroomPath));
		if (snapshot.artifacts.length === 0) return;
		return snapshot;
	}
	async function persistConfirmedShowroomSnapshot(snapshot) {
		await saveSnapshot(snapshot);
		await syncSlotLocksFromScrape(snapshot.slotLocks ?? {});
	}
	async function invalidateSnapshotFreshness() {
		const snapshot = await loadSnapshot();
		if (!snapshot) return;
		await saveSnapshot({
			...snapshot,
			scrapedAt: new Date(0).toISOString()
		});
	}
	function equippedSignature(snapshot) {
		const equipped = snapshot.artifacts.filter((artifact) => artifact.equippedPosition !== void 0).map((artifact) => `${artifact.instanceId}:${artifact.equippedPosition}:${artifact.slotLocked === true ? "1" : "0"}`).toSorted((left, right) => left.localeCompare(right));
		const locks = [
			1,
			2,
			3
		].map((position) => snapshot.slotLocks?.[position] === true ? "1" : "0").join("");
		return `${equipped.join(",")}|${locks}`;
	}
	async function resyncShowroomSnapshot() {
		const previous = await loadSnapshot();
		const previousSig = previous ? equippedSignature(previous) : "";
		let snapshot = await fetchShowroomSnapshot();
		if (snapshot && equippedSignature(snapshot) === previousSig) {
			await delay(EQUIP_CONFIRM_RETRY_MS);
			snapshot = await fetchShowroomSnapshot() ?? snapshot;
		}
		if (!snapshot) {
			await invalidateSnapshotFreshness();
			return {
				snapshot: void 0,
				didChange: false
			};
		}
		const didChange = equippedSignature(snapshot) !== previousSig;
		if (didChange) await persistConfirmedShowroomSnapshot(snapshot);
		else await invalidateSnapshotFreshness();
		return {
			snapshot,
			didChange
		};
	}
	async function confirmShowroomLoadout(applied) {
		if (applied.length === 0) return;
		const didConfirm = async () => {
			const snapshot = await fetchShowroomSnapshot();
			if (!snapshot) return false;
			if (!hasSnapshotLoadout(snapshot, applied)) return false;
			await persistConfirmedShowroomSnapshot(snapshot);
			return true;
		};
		if (await didConfirm()) return;
		await delay(EQUIP_CONFIRM_RETRY_MS);
		if (await didConfirm()) return;
		await invalidateSnapshotFreshness();
	}
	async function ensureArtifactSnapshot(options = {}) {
		const existing = await loadSnapshot();
		const isWantsForce = options.force === true;
		if (!isWantsForce && isSnapshotFresh(existing) && areSlotLocksFresh(existing)) return existing;
		const showroomPath = resolveShowroomUrl(existing?.username);
		if (isWantsForce) return scrapeShowroomAfterLockNudge(showroomPath, existing);
		const loaded = await loadRemotePage(showroomPath);
		if (!loaded) {
			if (existing?.slotLocks) await syncSlotLocksFromScrape(existing.slotLocks);
			return existing;
		}
		const snapshot = await persistShowroomSnapshot(loaded, showroomPath, existing);
		if (snapshot) return snapshot;
		if (existing?.slotLocks) await syncSlotLocksFromScrape(existing.slotLocks);
		return existing;
	}
	function markCommunityEventUnavailable(next) {
		next.caps.steamCommunityEvent = "capped";
		if (next.communityEvent) next.communityEvent = markCommunityEventEnded(next.communityEvent);
	}
	function cachedLiveCommunityEvent(next, banner) {
		const previous = next.communityEvent;
		return {
			scrapedAt: new Date().toISOString(),
			url: banner.url,
			isLive: true,
			personalHours: previous?.personalHours ?? 0,
			milestones: previous?.milestones ?? [],
			pendingArp: previous?.pendingArp ?? 0,
			awardedArp: previous?.awardedArp ?? 0,
			...previous?.communityHours !== void 0 && { communityHours: previous.communityHours },
			...previous?.communityHoursCap !== void 0 && { communityHoursCap: previous.communityHoursCap },
			...previous?.communityHoursSamples && { communityHoursSamples: previous.communityHoursSamples },
			...previous?.communityHoursSource && { communityHoursSource: previous.communityHoursSource },
			...banner.title && { title: banner.title },
			...previous?.playEligibility && { playEligibility: previous.playEligibility }
		};
	}
	async function refreshLiveCommunityEvent(next, controlDocument) {
		const banner = controlDocument ? scrapeLiveCommunityEventBanner(controlDocument) : void 0;
		if (!banner) {
			if (controlDocument === document && !isControlCenterDocumentReady(document)) return;
			markCommunityEventUnavailable(next);
			return;
		}
		const eventDocument = await loadRemoteDocument(banner.url);
		if (!eventDocument) {
			next.caps.steamCommunityEvent = "available";
			next.communityEvent = cachedLiveCommunityEvent(next, banner);
			return;
		}
		const scraped = scrapeCommunityEventFromDocument(eventDocument, banner.url);
		if (banner.title && !scraped.title) {
			const cleaned = banner.title.replaceAll(/\bLIVE\b/gi, "").replace(/Event:\s*[\d./\s-]+/i, "").replaceAll(/\s+/g, " ").trim();
			if (cleaned) scraped.title = cleaned;
		}
		next.communityEvent = mergeCommunityEventScrape(scraped, next.communityEvent, { source: "remote" });
		next.caps.steamCommunityEvent = next.communityEvent.isLive ? "available" : "capped";
	}
	function applyWatchTwitchProgress(next, document_) {
		const twitch = scrapeWatchTwitchProgressFromDocument(document_, next.watchTwitch);
		if (twitch) next.watchTwitch = twitch;
	}
	function shouldFetchSteamQuestEligibility(quest) {
		return quest.status !== "complete" && Boolean(quest.href) && !isChooseYourOwnGameQuest(quest) && quest.eligibility !== "eligible" && quest.isFree !== false;
	}
	async function enrichSteamQuestRow(quest) {
		if (!shouldFetchSteamQuestEligibility(quest) || !quest.href) return quest;
		const questDocument = await loadRemoteDocument(quest.href);
		if (!questDocument) return quest;
		const eligibility = scrapeSteamPlayEligibilityFromDocument(questDocument, { href: quest.href });
		const steamAppId = scrapeSteamAppIdFromDocument(questDocument) ?? quest.steamAppId;
		const nextQuest = {
			...quest,
			eligibility
		};
		if (steamAppId !== void 0) nextQuest.steamAppId = steamAppId;
		return nextQuest;
	}
	async function enrichSteamQuestEligibility(next) {
		const quests = next.steamQuests?.quests;
		if (!quests || quests.length === 0) return;
		const updated = await Promise.all(quests.map((quest) => enrichSteamQuestRow(quest)));
		next.steamQuests = {
			scrapedAt: new Date().toISOString(),
			quests: updated
		};
		const cap = steamQuestsCapFromRows(updated);
		if (cap) next.caps.steamQuests = cap;
	}
	function isLiveControlCenterPage() {
		let path = location.pathname;
		while (path.endsWith("/") && path.length > 1) path = path.slice(0, -1);
		return path.endsWith("/control-center");
	}
	async function loadControlCenterDocument() {
		if (!isLiveControlCenterPage()) return loadRemoteDocument(CONTROL_CENTER_PATH);
		if (isControlCenterActivityReady(document)) return document;
		await waitForControlCenterDocument();
		if (isControlCenterDocumentReady(document)) return document;
		return loadRemoteDocument(CONTROL_CENTER_PATH);
	}
	function applyControlCenterDocument(next, controlDocument) {
		const userArpTier = scrapeUserArpTierFromDocument(controlDocument);
		if (userArpTier !== void 0) next.userArpTier = userArpTier;
		applyRedeemableArpFromDocument(next, controlDocument);
		Object.assign(next.caps, scrapeControlCenterCapsFromDocument(controlDocument));
		applySteamQuestsFromDocument(next, controlDocument);
		applyDailyQuestsFromDocument(next, controlDocument);
		applyWatchTwitchProgress(next, controlDocument);
		applyBattlePassEndFromDocument(next, controlDocument);
	}
	async function refreshActivityPages(next) {
		const [controlDocument, questDocument, battleDocument, vaultDocument] = await Promise.all([
			loadControlCenterDocument(),
			loadRemoteDocument(QUEST_SETUP_PATH),
			loadRemoteDocument(BATTLE_PASS_PATH),
			loadRemoteDocument(GAME_VAULT_PATH)
		]);
		if (controlDocument) applyControlCenterDocument(next, controlDocument);
		if (questDocument) applyWatchTwitchProgress(next, questDocument);
		if (battleDocument) {
			const battlePass = scrapeBattlePassFromDocument(battleDocument);
			if (battlePass) next.battlePass = mergeBattlePassScrape(battlePass, next.battlePass);
		}
		if (vaultDocument) applyGameVaultDocument(next, vaultDocument);
		await Promise.all([controlDocument ? refreshLiveCommunityEvent(next, controlDocument) : Promise.resolve(), enrichSteamQuestEligibility(next)]);
	}
	function applyArpLogReconciliation(next) {
		next.caps = applyArpLogActivityCaps(next.caps, next.arpLog);
		if (!next.communityEvent) return;
		next.communityEvent = reconcileCommunityEventWithArpLog(next.communityEvent, next.arpLog);
	}
	function reconcileCachedSiteState(existing) {
		const next = {
			...existing,
			caps: { ...existing.caps }
		};
		applyArpLogReconciliation(next);
		return next;
	}
	async function refreshStaleLiveEvent(next) {
		const event = next.communityEvent;
		if (!event?.isLive) return;
		const eventDocument = await loadRemoteDocument(event.url);
		if (!eventDocument) return;
		next.communityEvent = mergeCommunityEventScrape(scrapeCommunityEventFromDocument(eventDocument, event.url), event, { source: "remote" });
		next.caps.steamCommunityEvent = next.communityEvent.isLive ? "available" : "capped";
	}
	async function refreshArpLog(next, existing, options) {
		const arpDocument = await loadRemoteDocument(resolveArpLogPath(next.communityEvent ?? existing.communityEvent));
		if (arpDocument) next.arpLog = mergeArpLogScrape(scrapeArpLogFromDocument(arpDocument), next.arpLog ?? existing.arpLog);
		if (options.refreshLiveEventAfter && next.communityEvent?.isLive) {
			const eventDocument = await loadRemoteDocument(next.communityEvent.url);
			if (eventDocument) next.communityEvent = mergeCommunityEventScrape(scrapeCommunityEventFromDocument(eventDocument, next.communityEvent.url), next.communityEvent, { source: "remote" });
		}
	}
	function requiresRemoteSnapshotHydrate(snapshot) {
		return !isSnapshotFresh(snapshot) || !areSlotLocksFresh(snapshot);
	}
	function requiresRemoteSiteHydrate(state, options = {}) {
		if (!state || options.force) return true;
		return !isCapsFresh(state) || shouldRescrapeBattlePass(state) || !isArpLogFresh(state) || shouldRefreshCommunityEventArpLog(state) || !isCommunityEventFresh(state) || requiresSteamQuestEligibilityFetch(state);
	}
	function shouldRefreshCommunityEventArpLog(state) {
		const event = state.communityEvent;
		if (!event?.isLive || event.pendingArp <= 0) return false;
		const received = sumCommunityEventRewardsFromArpLog(state.arpLog);
		if (received <= 0) return true;
		return event.awardedArp > 0 && received < event.awardedArp;
	}
	async function ensureSiteState(options = {}) {
		const existing = await loadSiteState() ?? emptySiteState();
		const isForce = options.force === true;
		const isForceCaps = isForce && !isScrapedWithin(existing.updatedAt, FORCE_REFRESH_COOLDOWN_MS);
		const isForceArpLog = isForce;
		const isForceEvent = isForce && !isScrapedWithin(existing.communityEvent?.scrapedAt, FORCE_REFRESH_COOLDOWN_MS);
		const requiresCapsRefresh = isForceCaps || !isCapsFresh(existing);
		const requiresBattlePassRefresh = isForce || requiresCapsRefresh || shouldRescrapeBattlePass(existing);
		const requiresArpLogRefresh = isForceArpLog || !isArpLogFresh(existing) || shouldRefreshCommunityEventArpLog(existing);
		const requiresEventRefresh = isForceEvent || !isCommunityEventFresh(existing);
		const requiresSteamEligibility = isForceCaps || requiresSteamQuestEligibilityFetch(existing);
		if (!requiresCapsRefresh && !requiresBattlePassRefresh && !requiresArpLogRefresh && !requiresEventRefresh && !requiresSteamEligibility) {
			const next = reconcileCachedSiteState(existing);
			await applyAsceCommunityHours(next);
			await applySteamFreeToPlayResolution(next);
			await saveSiteState(next);
			return next;
		}
		const next = {
			...existing,
			updatedAt: new Date().toISOString(),
			caps: { ...existing.caps }
		};
		if (requiresCapsRefresh) await refreshActivityPages(next);
		else {
			if (requiresBattlePassRefresh) await refreshBattlePassOnly(next);
			if (requiresEventRefresh) await refreshStaleLiveEvent(next);
			if (requiresSteamEligibility) await enrichSteamQuestEligibility(next);
		}
		if (requiresArpLogRefresh) await refreshArpLog(next, existing, { refreshLiveEventAfter: !requiresCapsRefresh && !requiresEventRefresh });
		applyArpLogReconciliation(next);
		await applySteamFreeToPlayResolution(next);
		await applyAsceCommunityHours(next);
		await saveSiteState(next);
		return next;
	}
	var dialogState = {};
	function onDialogKeydown(event) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopImmediatePropagation();
			closeAoDialog(dialogState.doesEscapeConfirm === true);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopImmediatePropagation();
			closeAoDialog(true);
		}
	}
	function closeAoDialog(isConfirmed) {
		if (dialogState.keyListener) {
			document.removeEventListener("keydown", dialogState.keyListener, { capture: true });
			delete dialogState.keyListener;
		}
		const resolve = dialogState.resolve;
		delete dialogState.resolve;
		delete dialogState.doesEscapeConfirm;
		document.querySelector(`#${DIALOG_ID}`)?.remove();
		resolve?.(isConfirmed);
	}
	function showAoDialog(options) {
		ensureOptimizerStyles();
		closeAoDialog(false);
		const root = document.createElement("div");
		root.id = DIALOG_ID;
		root.setAttribute("role", "dialog");
		root.setAttribute("aria-modal", "true");
		const title = options.title ?? "Artifact Optimizer";
		root.setAttribute("aria-label", title);
		const cancelButton = options.cancelLabel ? `<button type="button" class="ao-secondary" data-ao-dialog="cancel">${escapeHtml(options.cancelLabel)}</button>` : "";
		const confirmClass = options.isDanger === true ? "ao-danger" : "";
		root.innerHTML = `
    <div class="ao-dialog-scrim" data-ao-dialog="cancel"></div>
    <div class="ao-dialog">
      <div class="ao-dialog-title">${escapeHtml(title)}</div>
      <div class="ao-dialog-message">${escapeHtml(options.message)}</div>
      <div class="ao-dialog-actions">
        ${cancelButton}
        <button type="button" class="${confirmClass}" data-ao-dialog="ok">${escapeHtml(options.confirmLabel ?? "OK")}</button>
      </div>
    </div>
  `;
		return new Promise((resolve) => {
			dialogState.resolve = resolve;
			root.addEventListener("click", (event) => {
				const target = event.target;
				if (!(target instanceof HTMLElement)) return;
				const actionElement = target.closest("[data-ao-dialog]");
				if (!(actionElement instanceof HTMLElement)) return;
				const action = actionElement.dataset.aoDialog;
				if (action === "ok") {
					closeAoDialog(true);
					return;
				}
				if (action === "cancel") closeAoDialog(!options.cancelLabel);
			});
			dialogState.doesEscapeConfirm = !options.cancelLabel;
			dialogState.keyListener = onDialogKeydown;
			document.addEventListener("keydown", onDialogKeydown, { capture: true });
			document.body.append(root);
			root.querySelector("[data-ao-dialog=\"ok\"]")?.focus();
		});
	}
	async function showAoAlert(message, title) {
		await showAoDialog({
			message,
			...title && { title },
			confirmLabel: "OK"
		});
	}
	async function didConfirmAoDialog(message, options = {}) {
		return showAoDialog({
			message,
			cancelLabel: "Cancel",
			confirmLabel: options.confirmLabel ?? "Confirm",
			...options.title && { title: options.title },
			...options.isDanger === true && { isDanger: true }
		});
	}
	function showAoToast(message) {
		ensureOptimizerStyles();
		document.querySelector(`#${TOAST_ID}`)?.remove();
		const toast = document.createElement("div");
		toast.id = TOAST_ID;
		toast.setAttribute("role", "status");
		toast.textContent = message;
		document.body.append(toast);
		setTimeout(() => {
			toast.remove();
		}, TOAST_MS);
	}
	var ACCOUNT_ACTIONS_OFF_MESSAGE = "Account actions are off. Enable them in the full panel.";
	async function didAllowAccountActions() {
		if (areAccountActionsEnabled(await getArtifactSettings())) return true;
		await showAoAlert(ACCOUNT_ACTIONS_OFF_MESSAGE, "Account actions off");
		return false;
	}
	var BP_CLAIM_ALL_PENDING_KEY = "ao-bp-claim-all";
	var BP_CLAIM_SKIP_ARP_VALUE = "skip-arp";
	async function persistBattlePassAfterClaim(options) {
		const state = await refreshSiteStateFromPage();
		const battlePass = state.battlePass;
		if (battlePass && options.claimed > 0 && !location.pathname.includes("/battle-pass")) {
			if (options.shouldSkipArpBoosts) {
				const leftover = (battlePass.readyClaims ?? []).filter((claim) => claim.isArp);
				const next = {
					...battlePass,
					readyToClaim: leftover.length,
					readyToClaimArp: leftover.length
				};
				if (leftover.length > 0) next.readyClaims = leftover;
				else delete next.readyClaims;
				state.battlePass = next;
			} else if (options.remaining === 0) {
				const next = {
					...battlePass,
					readyToClaim: 0,
					readyToClaimArp: 0
				};
				delete next.readyClaims;
				state.battlePass = next;
			} else state.battlePass = {
				...battlePass,
				readyToClaim: Math.max(0, battlePass.readyToClaim - options.claimed)
			};
		}
		await saveSiteState(state);
	}
	async function runBattlePassClaims(options) {
		const shouldSkipArpBoosts = options.shouldSkipArpBoosts;
		showAoToast(shouldSkipArpBoosts ? "Claiming Battle Pass rewards (leaving ARP Boosts)…" : "Claiming Battle Pass rewards…");
		const readyClaims = (await loadSiteState())?.battlePass?.readyClaims;
		const { claimed, remaining, needsBattlePassPage } = await claimAllBattlePassRewards({
			shouldSkipArpBoosts,
			...readyClaims && { readyClaims }
		});
		if (needsBattlePassPage === true) {
			showAoToast("Opening Battle Pass to claim…");
			sessionStorage.setItem(BP_CLAIM_ALL_PENDING_KEY, shouldSkipArpBoosts ? BP_CLAIM_SKIP_ARP_VALUE : "1");
			const state = await loadSiteState();
			location.assign(state?.battlePass?.url ?? "/control-center/battle-pass/1");
			return;
		}
		try {
			await persistBattlePassAfterClaim({
				claimed,
				remaining,
				shouldSkipArpBoosts
			});
		} catch (error) {
			console.error("[AWA Toolkit] Failed to refresh Battle Pass after claim", error);
		}
		if (claimed === 0) {
			await showAoAlert("Could not claim any Battle Pass rewards.");
			return;
		}
		if (remaining > 0) {
			await showAoAlert(`Claimed ${claimed}. ${remaining} still showing CLAIM — try Claim all again.`);
			return;
		}
		if (shouldSkipArpBoosts) {
			showAoToast(`Claimed ${claimed} Battle Pass reward(s). ARP Boosts were left for All-ARP%.`);
			return;
		}
		showAoToast(`Claimed ${claimed} Battle Pass reward(s).`);
	}
	async function handleClaimAllBattlePass(options = {}) {
		if (!await didAllowAccountActions()) return;
		const isOnBattlePassPage = location.pathname.includes("/battle-pass");
		const liveAll = isOnBattlePassPage ? listBattlePassClaimButtons().length : 0;
		const liveNonArp = isOnBattlePassPage ? listBattlePassClaimButtons(document, { shouldSkipArpBoosts: true }).length : 0;
		const battlePass = (await loadSiteState())?.battlePass;
		const ready = liveAll > 0 ? liveAll : battlePass?.readyToClaim ?? 0;
		const arp = battlePassClaimableArp(battlePass);
		const nonArp = liveNonArp > 0 ? liveNonArp : battlePassReadyNonArp(battlePass);
		const shouldSkipArpBoosts = options.shouldSkipArpBoosts === true && arp > 0;
		if ((shouldSkipArpBoosts ? nonArp : ready) <= 0) {
			await showAoAlert("No Battle Pass rewards are ready to claim.");
			return;
		}
		const arpBoostLabel = arp === 1 ? "ARP Boost" : "ARP Boosts";
		const arpBoostPart = arp > 0 ? ` (${arp} ${arpBoostLabel})` : "";
		if (!await didConfirmAoDialog(shouldSkipArpBoosts ? `Claim ${nonArp} Battle Pass reward(s) now, and leave ${arp} ${arpBoostLabel} until All-ARP% is equipped?` : `Claim all ${ready} ready Battle Pass reward(s)${arpBoostPart}?`, {
			title: "Claim Battle Pass",
			confirmLabel: shouldSkipArpBoosts ? "Claim (skip ARP)" : "Claim all"
		})) return;
		await runBattlePassClaims({ shouldSkipArpBoosts });
	}
	async function consumePendingBattlePassClaimAll() {
		const pending = sessionStorage.getItem(BP_CLAIM_ALL_PENDING_KEY);
		if (pending !== "1" && pending !== BP_CLAIM_SKIP_ARP_VALUE) return;
		if (!areAccountActionsEnabled(await getArtifactSettings())) {
			sessionStorage.removeItem(BP_CLAIM_ALL_PENDING_KEY);
			showAoToast("Account actions are off. Enable them in the full panel.");
			return;
		}
		sessionStorage.removeItem(BP_CLAIM_ALL_PENDING_KEY);
		await waitForBattlePassDocument();
		await runBattlePassClaims({ shouldSkipArpBoosts: pending === BP_CLAIM_SKIP_ARP_VALUE });
	}
	function bindClaimAllButtons(root) {
		for (const button of root.querySelectorAll(".ao-claim-btn")) button.addEventListener("click", () => {
			handleClaimAllBattlePass({ shouldSkipArpBoosts: button.dataset.skipArp === "1" });
		});
	}
	function isControlCenterPage() {
		let path = location.pathname;
		while (path.endsWith("/") && path.length > 1) path = path.slice(0, -1);
		return path.endsWith("/control-center");
	}
	function isSiteStatePage() {
		const path = location.pathname;
		return path.includes("/control-center") || path.includes("/marketplace") || path.includes("/game-vault") || path.includes("/battle-pass") || path.includes("/arp-log") || path.includes("/steam/community-event");
	}
	function loadCachedOrRemoteSnapshot(isRemote, options = {}) {
		if (isRemote) return ensureArtifactSnapshot({ force: options.force === true });
		return loadSnapshot();
	}
	function hasGmStorage() {
		return typeof _GM?.getValue === "function";
	}
	function assertGmStorage() {
		if (!hasGmStorage()) throw new TypeError("GM storage is unavailable. For pnpm run dev, install the userscript served at http://localhost:3000 (named server:AWA Toolkit). A custom stub that only @requires that file does not get @grant, so recommendations never load.");
	}
	async function gatherData(options) {
		assertGmStorage();
		const isRemote = options?.remote ?? true;
		const shouldForceSite = options?.forceSite === true;
		const snapshotPromise = !shouldForceSite && isArtifactsShowroomPage() ? scrapeAndPersist() : loadCachedOrRemoteSnapshot(isRemote || isArtifactsShowroomPage(), { force: shouldForceSite });
		const siteStatePromise = isRemote ? ensureSiteState({ force: shouldForceSite }) : loadSiteState();
		const [snapshot, loadedState] = await Promise.all([snapshotPromise, siteStatePromise]);
		if (snapshot?.slotLocks) await syncSlotLocksFromScrape(snapshot.slotLocks);
		const settings = await getArtifactSettings();
		let siteState = loadedState ?? emptySiteState();
		if (isSiteStatePage()) {
			if (isRemote) siteState = await refreshSiteStateFromPage();
			else applyLiveDocumentToSiteState(siteState);
		}
		await applyAsceCommunityHours(siteState);
		if (isSiteStatePage()) await saveSiteState(siteState);
		const emptySnapshot = {
			scrapedAt: new Date(0).toISOString(),
			username: void 0,
			fragments: settings.manualFragments ?? 0,
			artifacts: []
		};
		const result = optimize(buildContext(snapshot ?? emptySnapshot, settings, siteState));
		return rememberGathered({
			snapshot,
			settings,
			siteState,
			result
		});
	}
	var gatheredCache = {};
	function rememberGathered(data) {
		gatheredCache.current = data;
		scheduleBrowserNotifications(data);
		return data;
	}
	async function warmNotificationSchedule() {
		if (!hasGmStorage() || gatheredCache.current) return;
		try {
			if (!(await getArtifactSettings()).browserNotifications) return;
			await gatherData({ remote: false });
		} catch {}
	}
	function snapshotForOptimize(data) {
		return data.snapshot ?? {
			scrapedAt: new Date(0).toISOString(),
			username: void 0,
			fragments: data.settings.manualFragments ?? 0,
			artifacts: []
		};
	}
	function requiresAsceHydrate(state) {
		if (!state.communityEvent?.isLive) return false;
		return state.communityEvent.communityHoursSource !== "asce" || hasPendingAsceRefresh();
	}
	function requiresBackgroundHydrate(data, options = {}) {
		if (options.force) return true;
		if (!isArtifactsShowroomPage() && requiresRemoteSnapshotHydrate(data.snapshot)) return true;
		if (requiresRemoteSiteHydrate(data.siteState)) return true;
		if (requiresSteamFreeHydrate(data.siteState)) return true;
		return requiresAsceHydrate(data.siteState);
	}
	async function hydrateAsceData(data, options = {}) {
		if (!data.siteState.communityEvent?.isLive) return;
		if (!await didRefreshAsceCommunityHours(data.siteState, { force: options.force === true })) return;
		await saveSiteState(data.siteState);
		const asceResult = optimize(buildContext(snapshotForOptimize(data), data.settings, data.siteState));
		return rememberGathered({
			...data,
			result: asceResult
		});
	}
	async function hydrateGatheredData(options = {}) {
		const remote = await gatherData({
			remote: true,
			forceSite: options.force === true
		});
		return await hydrateAsceData(remote, { force: options.force === true }) ?? remote;
	}
	function renderSectionDivider() {
		return "<hr class=\"ao-divider\" />";
	}
	function renderNotifySwitch(options) {
		return `
      <label class="ao-switch${options.isSmall === true ? " ao-switch-sm" : ""}">
        <span class="ao-switch-copy">
          <span class="ao-switch-title">${escapeHtml(options.title)}</span>
          <span class="ao-switch-hint">${escapeHtml(options.hint)}</span>
        </span>
        <input type="checkbox" id="${escapeHtml(options.id)}" class="ao-switch-input" ${options.isChecked ? "checked" : ""}/>
        <span class="ao-switch-track" aria-hidden="true"><span class="ao-switch-knob"></span></span>
      </label>`;
	}
	function renderNotifyTypeSwitches(settings) {
		const switches = NOTIFICATION_TYPE_KEYS.map((key) => {
			const copy = NOTIFICATION_TYPE_COPY[key];
			if (!copy) return "";
			return renderNotifySwitch({
				id: `ao-notify-type-${key}`,
				title: copy.title,
				hint: copy.hint,
				isChecked: isNotificationTypeEnabled(settings, key),
				isSmall: true
			});
		}).join("");
		return `
      <div class="ao-notify-types"${settings.browserNotifications ? "" : " data-off=\"\""}>
        ${switches}
      </div>`;
	}
	var SKELETON_BAR_WIDTHS = [
		"88%",
		"72%",
		"64%",
		"48%"
	];
	function renderHydrateBanner(message) {
		return `<div class="ao-hydrate" role="status" aria-live="polite"><span class="ao-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></div>`;
	}
	function renderSkeletonBars() {
		return SKELETON_BAR_WIDTHS.map((width) => `<div class="ao-skel" style="width:${width}"></div>`).join("");
	}
	function renderPanelError(message) {
		return `
    <div class="ao-heading">AWA Toolkit</div>
    <div class="ao-note">${escapeHtml(message)}</div>
  `;
	}
	function renderPanelSkeleton(message = "Loading recommendations…") {
		return `
    <div class="ao-heading">AWA Toolkit</div>
    ${renderHydrateBanner(message)}
    <div id="ao-action-plan" class="ao-skel-block">
      <div class="ao-heading">What to do</div>
      ${renderSkeletonBars()}
    </div>
    ${renderSectionDivider()}
    <div class="ao-skel-block">
      ${renderSkeletonBars()}
    </div>
    <div class="ao-actions">
      <button type="button" disabled>Equip Recommended</button>
      <button type="button" class="ao-secondary" disabled>Open Full Panel</button>
    </div>
  `;
	}
	function renderModalSkeleton() {
		return `
    ${renderHydrateBanner("Loading recommendations…")}
    <div id="ao-action-plan" class="ao-skel-block">
      <div class="ao-heading">What to do</div>
      ${renderSkeletonBars()}
    </div>
    ${renderSectionDivider()}
    <div class="ao-skel-block">${renderSkeletonBars()}</div>
  `;
	}
	function formatEquippedLabel(result) {
		if (!result.current) return "None detected";
		return sortArtifactsForDisplay(result.current.artifacts).map((artifact) => {
			return artifact.slotLocked === true ? `${artifact.displayName} (locked)` : artifact.displayName;
		}).join(" + ");
	}
	var ACTIVITY_LABELS = {
		timeOnSite: "Time on Site",
		steamQuests: "Steam Quests",
		watchTwitch: "Watch Twitch",
		dailyCalendar: "Daily Calendar",
		discordPoll: "Discord Poll",
		dailyQuests: "Daily / weekend quests",
		steamCommunityEvent: "Steam Community Event"
	};
	var BREAKDOWN_LABELS = {
		...ACTIVITY_LABELS,
		dailyQuests: "Daily quests",
		weekendQuests: "Weekend quests",
		battlePassClaims: "Battle Pass claims"
	};
	function breakdownLabel(key) {
		return BREAKDOWN_LABELS[key] ?? key;
	}
	function formatBreakdownLine(entry) {
		const parts = [entry.base];
		if (entry.categoryBonus !== 0) parts.push(entry.categoryBonus);
		if (entry.allArpBonus !== 0) parts.push(entry.allArpBonus);
		if (parts.length === 1) return `~${entry.total} ARP`;
		return `~${entry.total} (${parts.join(" + ")})`;
	}
	function renderBreakdown(result) {
		if (!result) return "";
		const rows = Object.entries(result.breakdown).filter(([, entry]) => entry.total !== 0).map(([k, entry]) => `<div class="ao-row ao-muted">${escapeHtml(breakdownLabel(k))}: ${formatBreakdownLine(entry)}</div>`).join("");
		return `
    ${result.activeSetNames.length > 0 ? `<div class="ao-row"><strong>Set:</strong> ${escapeHtml(result.activeSetNames.join(", "))}</div>` : ""}
    <div class="ao-row">Estimated lock-window ARP: <strong>${result.weeklyArp}</strong></div>
    ${result.marketplaceSavingsArp > 0 ? `<div class="ao-row">Market savings: <strong>${result.marketplaceSavingsArp}</strong></div>` : ""}
    <div class="ao-row">All ARP multiplier: <strong>${(result.allArpPct * 100).toFixed(0)}%</strong></div>
    <details>
      <summary class="ao-muted">Breakdown</summary>
      ${rows}
    </details>
  `;
	}
	function renderTextLink(label, url, dateAccessed) {
		const accessedSuffix = dateAccessed ? ` (on ${dateAccessed})` : "";
		return `<a class="ao-text-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>${accessedSuffix}`;
	}
	function renderCredits(options) {
		if (CREDIT_SOURCES.length === 0) return "";
		const sourceLinks = CREDIT_SOURCES.map((source) => renderTextLink(source.label, source.url, source.dateAccessed)).join(", ");
		if (options?.compact) return `<div class="ao-muted ao-credit">Sources: ${sourceLinks}</div>`;
		const detailLinks = CREDIT_SOURCES.flatMap((source) => source.links ?? []).map((link) => renderTextLink(link.label, link.url)).join(", ");
		return `<div class="ao-muted ao-credit">Sources: ${sourceLinks}${detailLinks ? ` · ${detailLinks}` : ""}</div>`;
	}
	function renderVaultDiscountBlock(result) {
		const hint = result.vaultDiscount;
		if (!hint || hint.dismissed || !hint.note) return "";
		return `<div class="ao-note ao-vault-discount">
    <div>${escapeHtml(hint.note)}</div>
    <div class="ao-note-actions">
      <button type="button" class="ao-secondary" data-ao-dismiss-vault="${escapeHtml(hint.cycleId)}">Skip vault discount</button>
    </div>
  </div>`;
	}
	function renderVaultDiscountRestore(result) {
		if (!result.vaultDiscount?.dismissed) return "";
		return `<div class="ao-row">
    Game Vault discount recs skipped for this rotation
    <button type="button" class="ao-secondary" data-ao-restore-vault>Restore</button>
  </div>`;
	}
	async function applyVaultDiscountDismiss(cycleId) {
		await saveArtifactSettings({ vaultDiscountDismissedCycle: cycleId });
	}
	async function restoreVaultDiscountRecs() {
		await saveArtifactSettings({ vaultDiscountDismissedCycle: "" });
	}
	function bindVaultDiscountActions(root, onChanged) {
		const dismiss = root.querySelector("[data-ao-dismiss-vault]");
		dismiss?.addEventListener("click", () => {
			const cycleId = dismiss.dataset.aoDismissVault;
			if (!cycleId) return;
			applyVaultDiscountDismiss(cycleId).then(() => onChanged());
		});
		root.querySelector("[data-ao-restore-vault]")?.addEventListener("click", () => {
			restoreVaultDiscountRecs().then(() => onChanged());
		});
	}
	function supplementalNotes(notes) {
		return notes.filter((note) => {
			if (/Battle Pass ARP Boost/i.test(note)) return false;
			if (/All-ARP%/i.test(note) && /community|unlocked by community/i.test(note)) return false;
			if (/^~\d+\s*ARP\b/i.test(note)) return false;
			return true;
		});
	}
	function renderCommunityEventBlock(siteState, options) {
		const event = siteState?.communityEvent;
		if (!event?.isLive) return "";
		const title = escapeHtml(event.title ?? "Steam Community Event");
		const pendingParts = describeCommunityEventPendingParts(event);
		const pending = `<strong>${escapeHtml(pendingParts.text)}</strong>`;
		const lines = [`<div><strong>${title}</strong></div>`, `<div>${event.personalHours}h played · ${pending}</div>`];
		if (pendingParts.later) lines.push(`<div class="ao-muted">${escapeHtml(pendingParts.later)}</div>`);
		if (options?.detailed) {
			const awardParts = [];
			if (event.awardedArp > 0) awardParts.push(`${event.awardedArp} on event page`);
			if ((event.receivedArpFromLog ?? 0) > 0) awardParts.push(`${event.receivedArpFromLog} in ARP Log`);
			if (awardParts.length > 0) lines.push(`<div class="ao-muted">Awarded: ${awardParts.join(" · ")}</div>`);
		}
		lines.push(`<div>${renderTextLink("Open event", event.url)}</div>`);
		return `<div class="ao-note">${lines.join("")}</div>`;
	}
	function renderBattlePassBlock(siteState, options = {}) {
		const bp = siteState?.battlePass;
		if (!bp) return "";
		const remaining = battlePassRemainingMs(bp);
		let endsPart = "";
		if (remaining !== void 0) endsPart = ` · ends in ${formatMs(remaining)}`;
		else if (bp.endsInText) endsPart = ` · ends in ${escapeHtml(bp.endsInText)}`;
		const lines = [`<div><strong>Battle Pass</strong> · ${bp.tokens ?? "?"} / ${bp.tokensMax ?? "?"} tokens${endsPart}</div>`];
		if (bp.readyToClaim > 0) {
			const arpBoostPart = bp.readyToClaimArp > 0 ? ` (${bp.readyToClaimArp} ARP Boost)` : "";
			lines.push(`<div><strong>${bp.readyToClaim} ready to claim</strong>${arpBoostPart}</div>`);
		}
		if (options.showClaimAll === true) {
			const skipArp = options.shouldSkipArpBoosts === true ? " data-skip-arp=\"1\"" : "";
			lines.push(`<div class="ao-note-actions"><button type="button" class="ao-claim-btn"${skipArp}>${battlePassClaimButtonLabel(options.shouldSkipArpBoosts === true)}</button></div>`);
		}
		lines.push(`<div>${renderTextLink("Open Battle Pass", bp.url)}</div>`);
		return `<div class="ao-note">${lines.join("")}</div>`;
	}
	function renderCooldownBlock(settings, slotLocks) {
		if (!slotLocks) return "";
		const lockedSlots = [
			1,
			2,
			3
		].filter((position) => slotLocks[position] === true);
		if (lockedSlots.length === 0) return "";
		return `<div class="ao-note">24h slot cooldown: ${formatLockedSlotParts(settings, lockedSlots, slotLocks).join(", ")}</div>`;
	}
	function renderArpLogCard(siteState) {
		const arp = siteState?.arpLog;
		if (!arp) return "";
		const when = new Date(arp.scrapedAt).toLocaleString();
		const redeemable = arp.redeemableArp?.toLocaleString() ?? "?";
		const today = arp.todayDelta === void 0 ? "" : `<div>Today so far: <strong>+${arp.todayDelta}</strong> ARP</div>`;
		const recent = arp.recent.slice(0, 5).map((entry) => `<div class="ao-muted">${escapeHtml(entry.action)} · ${entry.arp}</div>`).join("");
		return `<div class="ao-note">
      <div><strong>ARP Log</strong> · scraped ${escapeHtml(when)}</div>
      <div>Redeemable: <strong>${redeemable}</strong></div>
      ${today}
      ${recent ? `<div style="margin-top:6px">Recent:</div>${recent}` : ""}
    </div>`;
	}
	function renderActivityCapsCard(siteState) {
		if (!siteState) return "";
		const caps = siteState.caps;
		const rows = Object.keys(ACTIVITY_LABELS).map((key) => {
			const status = caps[key];
			if (!status || status === "unknown") return "";
			const label = ACTIVITY_LABELS[key] ?? key;
			const word = status === "available" ? "available" : "done / capped";
			return `<div class="${(status === "available" ? "" : " ao-muted").trim()}">${escapeHtml(label)} · ${word}</div>`;
		}).filter(Boolean);
		if (rows.length === 0) return "";
		return `<div class="ao-note">
      <div><strong>Activity caps</strong>${siteState.updatedAt ? ` · ${escapeHtml(new Date(siteState.updatedAt).toLocaleString())}` : ""}</div>
      ${rows.join("")}
    </div>`;
	}
	function renderStatusSection(settings, siteState, slotLocks, options = {}) {
		const cards = [
			renderBattlePassBlock(siteState, {
				showClaimAll: options.showBattlePassClaimAll === true,
				shouldSkipArpBoosts: options.shouldSkipArpBoosts === true
			}),
			renderCommunityEventBlock(siteState, { detailed: true }),
			renderCooldownBlock(settings, slotLocks),
			renderActivityCapsCard(siteState),
			renderArpLogCard(siteState)
		].filter(Boolean);
		if (cards.length === 0) return "";
		return `
    <div class="ao-heading">Status</div>
    ${cards.join("")}
  `;
	}
	function formatSwapMessage(result) {
		if (result.dailySwap) return `<div class="ao-row">${wrapArtifactNames(result.dailySwap.reason)}</div>`;
		const currentIds = new Set((result.current?.artifacts ?? []).map((a) => a.instanceId));
		const bestIds = new Set((result.best?.artifacts ?? []).map((a) => a.instanceId));
		if (bestIds.size > 0 && bestIds.size === currentIds.size && [...bestIds].every((id) => currentIds.has(id))) return `<div class="ao-row ao-muted">Current loadout matches the recommendation.</div>`;
		if ((result.current?.artifacts.length ?? 0) < 3) return `<div class="ao-row ao-muted">Equipped slots are incomplete (${result.current?.artifacts.length ?? 0}/3) — use Equip Recommended to fill empty slots.</div>`;
		return `<div class="ao-row ao-muted">Could not compute a single-piece swap — use Equip Recommended.</div>`;
	}
	function renderUpgradePath(upgrades, fragments, options = {}) {
		if (upgrades.length === 0) return `<div class="ao-row ao-muted">No ARP upgrades left on owned artifacts.</div>`;
		const shouldShowUpgradeButtons = options.shouldShowUpgradeButtons !== false;
		const seenAffordable = new Set();
		let hasReachedSave = false;
		return upgrades.map((upgrade) => {
			const step = `${TIER_LABELS[upgrade.fromTier]} → ${TIER_LABELS[upgrade.toTier]}`;
			const gain = `+${upgrade.arpGain} ARP/mo`;
			if (upgrade.isAffordable) {
				const isFirstAffordable = !seenAffordable.has(upgrade.artifact.instanceId);
				seenAffordable.add(upgrade.artifact.instanceId);
				const verb = isFirstAffordable ? "Upgrade" : "Then";
				const button = shouldShowUpgradeButtons && isFirstAffordable ? `<button type="button" class="ao-upgrade-btn" data-id="${upgrade.artifact.instanceId}">Upgrade</button>` : "";
				return `
        <div class="ao-row">
          ${verb} <strong>${wrapArtifactNames(upgrade.artifact.displayName)}</strong>
          ${step}
          (${upgrade.fragmentCost} frag, ${gain}, ${upgrade.efficiency.toFixed(1)} ARP/frag)
          ${button}
        </div>`;
			}
			if (!hasReachedSave) {
				hasReachedSave = true;
				return `
        <div class="ao-row ao-muted">
          Save for <strong>${wrapArtifactNames(upgrade.artifact.displayName)}</strong>
          ${step}
          (need ${upgrade.fragmentCost}, have ${fragments}, ${gain})
        </div>`;
			}
			return `
        <div class="ao-row ao-muted">
          Then <strong>${wrapArtifactNames(upgrade.artifact.displayName)}</strong>
          ${step}
          (${upgrade.fragmentCost} frag, ${gain})
        </div>`;
		}).join("");
	}
	function renderResultBody(result, snapshot, settings, siteState, options = {}) {
		const scrapedAt = snapshot?.scrapedAt ? new Date(snapshot.scrapedAt).toLocaleString() : "never";
		const fragments = settings.manualFragments ?? snapshot?.fragments ?? 0;
		const hydrateBanner = options.isHydrating ? renderHydrateBanner("Updating in the background…") : "";
		const extras = supplementalNotes(result.notes).map((n) => `<div class="ao-note">${wrapArtifactNames(n)}</div>`).join("");
		const vaultDiscount = renderVaultDiscountBlock(result);
		const areActionsEnabled = areAccountActionsEnabled(settings);
		const upgrades = renderUpgradePath(result.upgrades, fragments, { shouldShowUpgradeButtons: areActionsEnabled });
		const swap = formatSwapMessage(result);
		const status = renderStatusSection(settings, siteState, snapshot?.slotLocks, {
			showBattlePassClaimAll: areActionsEnabled && shouldShowBattlePassClaimAll(siteState?.battlePass, result.deferBattlePassClaims === true),
			shouldSkipArpBoosts: shouldSkipArpInBattlePassClaimAll(siteState?.battlePass, result.deferBattlePassClaims === true)
		});
		const equippedLabel = formatEquippedLabel(result);
		const activityToggles = Object.keys(settings.activities).map((key) => {
			const a = settings.activities[key];
			const label = ACTIVITY_LABELS[key] ?? key;
			return `
        <label class="ao-toggle">
          <input type="checkbox" data-activity="${key}" ${a.enabled ? "checked" : ""}/>
          ${label} <span class="ao-muted">(freq)</span>
          <input type="number" min="0" max="2" step="0.1" data-freq="${key}" value="${a.frequency}"/>
        </label>`;
		}).join("");
		return `
    <div class="ao-notify">
      ${renderNotifySwitch({
			id: "ao-account-actions",
			title: "Account actions",
			hint: "Equip artifacts, upgrade, and claim Battle Pass for you. Use at your own risk.",
			isChecked: areActionsEnabled
		})}
      ${renderNotifySwitch({
			id: "ao-browser-notifications",
			title: "Desktop notifications",
			hint: "Master switch. Turning this on asks the browser for permission.",
			isChecked: settings.browserNotifications
		})}
      ${renderNotifyTypeSwitches(settings)}
    </div>
    ${hydrateBanner}
    <div class="ao-muted">Inventory snapshot: ${scrapedAt} · Fragments: ${fragments}</div>
    ${vaultDiscount}
    ${extras}
    ${renderSectionDivider()}
    <div class="ao-heading">Recommended loadout</div>
    <div class="ao-row"><strong>${wrapArtifactNames(comboLabel(result.best))}</strong></div>
    ${renderBreakdown(result.best)}
    <div class="ao-heading">Currently equipped</div>
    <div class="ao-row">${wrapArtifactNames(equippedLabel)}</div>
    ${result.current ? renderBreakdown(result.current) : ""}
    <div class="ao-heading">Suggested swap</div>
    ${swap}
    <div class="ao-heading">Upgrade priority</div>
    ${upgrades}
    ${status}
    <details class="ao-advanced">
      <summary>Advanced / manual overrides</summary>
      <div class="ao-heading">Activity profile</div>
      ${renderVaultDiscountRestore(result)}
      ${activityToggles}
      <div class="ao-row">
        Target Game Vault purchase (ARP):
        <input type="number" id="ao-vault-price" min="0" step="1" value="${settings.pendingVaultPurchaseArp}"/>
      </div>
      <div class="ao-row">
        Manual fragment override (blank = scraped):
        <input type="number" id="ao-manual-frags" min="0" step="1" value="${settings.manualFragments ?? ""}" placeholder="auto"/>
      </div>
      <div class="ao-heading">Preferred Twitch streamers</div>
      <div class="ao-muted">One login per line. Live preferred channels open first (top to bottom). If none are live: random Featured/Hive/Nexus with "drops" in the title, then any Featured/Hive/Nexus, then any "drops" title, then a random remaining stream.</div>
      <textarea id="ao-preferred-twitch" class="ao-textarea" rows="4" placeholder="ludwig">${escapeHtml(settings.preferredTwitchStreamers.join("\n"))}</textarea>
      <div class="ao-heading">UTC daily cutoff</div>
      <div class="ao-muted">Hours before 00:00 UTC to keep free for Twitch / Time on Site. Raise this if a 24h All-ARP% lock would leave too little time after it ends (a +1 community bump is not worth squeezing Twitch).</div>
      <div class="ao-row">
        <input type="number" id="ao-utc-daily-cutoff" min="0" max="12" step="0.5" value="${settings.utcDailyEndBufferHours}"/>
      </div>
      <div class="ao-heading">Manual artifacts</div>
      <div class="ao-muted">Only needed if auto-scrape fails.</div>
      <div class="ao-row">
        <select id="ao-manual-family">
          ${ARTIFACTS.map((a) => `<option value="${a.id}">${a.id}</option>`).join("")}
        </select>
        <select id="ao-manual-tier">
          ${Object.entries(TIER_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        </select>
        <button type="button" id="ao-add-manual">Add</button>
      </div>
      <div id="ao-manual-list" class="ao-row">
        ${settings.manualArtifacts.length === 0 ? "<span class=\"ao-muted\">None</span>" : settings.manualArtifacts.map((m, index) => `<div>${m.familyId} @ ${TIER_LABELS[m.tier]}
                      <button type="button" class="ao-remove-manual ao-secondary" data-index="${index}">Remove</button>
                     </div>`).join("")}
      </div>
    </details>
  `;
	}
	var QUESTS_PATH = "/quests";
	var TWITCH_HOST = /(^|\.)twitch\.tv$/i;
	function twitchLoginFromHref(href) {
		try {
			const url = new URL(href, location.origin);
			if (!TWITCH_HOST.test(url.hostname)) return;
			const login = url.pathname.replace(/^\//, "").split("/", 1)[0];
			if (!login) return;
			return login.toLowerCase();
		} catch {
			return;
		}
	}
	function headingGroup(text) {
		const label = text.replaceAll(/\s+/g, " ").trim();
		if (/^featured\b/i.test(label)) return "featured";
		if (/^hive\b/i.test(label)) return "hive";
		if (/^nexus\b/i.test(label)) return "nexus";
		if (/^partners?\b/i.test(label)) return "partner";
	}
	function twitchWatchUrl(href, login) {
		try {
			const url = new URL(href, location.origin);
			if (TWITCH_HOST.test(url.hostname)) return url.href;
		} catch {}
		return `https://www.twitch.tv/${login}`;
	}
	function streamFromRow(row, group) {
		const link = row.querySelector("a[href*=\"twitch.tv\"]");
		const href = link?.getAttribute("href") ?? "";
		const login = twitchLoginFromHref(href);
		if (!login) return;
		const details = row.querySelector(".quest-list__quest-details");
		const nameText = [...details?.children ?? []].find((child) => !child.classList.contains("small"))?.textContent ?? row.querySelector("img")?.getAttribute("alt") ?? link?.textContent;
		const title = details?.querySelector(".small")?.textContent?.replaceAll(/\s+/g, " ").trim() ?? "";
		const displayName = nameText?.replaceAll(/\s+/g, " ").trim() || login;
		const resolvedGroup = group === "partner" && (row.classList.contains("speed-boost") || row.querySelector(".featured") !== null) ? "featured" : group;
		return {
			login,
			displayName,
			title,
			url: twitchWatchUrl(href, login),
			group: resolvedGroup
		};
	}
	function scrapeLiveTwitchStreams(document_) {
		const card = findActivityCard(document_, /^Watch Twitch$/i);
		if (!card) return [];
		const body = card.querySelector(".user-profile__card-body") ?? card;
		const streams = [];
		const seen = new Set();
		let group = "partner";
		for (const node of body.querySelectorAll(".card-table-heading, .card-table-row")) {
			if (node.classList.contains("card-table-heading")) {
				group = headingGroup(node.textContent ?? "") ?? group;
				continue;
			}
			const stream = streamFromRow(node, group);
			if (!stream || seen.has(stream.login)) continue;
			seen.add(stream.login);
			streams.push(stream);
		}
		return streams;
	}
	function pickRandom(items) {
		if (items.length === 0) return;
		const bytes = new Uint32Array(1);
		crypto.getRandomValues(bytes);
		return items[(bytes[0] ?? 0) % items.length];
	}
	function hasDropsInTitle(stream) {
		return /drops/i.test(stream.title);
	}
	var DOUBLE_ARP_GROUPS = new Set([
		"featured",
		"hive",
		"nexus"
	]);
	function isDoubleArp(stream) {
		return DOUBLE_ARP_GROUPS.has(stream.group);
	}
	function isPreferredMatch(stream, preferredLogin) {
		if (stream.login === preferredLogin) return true;
		return stream.displayName.replaceAll(/\s+/g, "").toLowerCase() === preferredLogin;
	}
	function pickFromPool(streams, reason, isMatch) {
		const stream = pickRandom(streams.filter((candidate) => isMatch(candidate)));
		if (!stream) return;
		return {
			stream,
			reason
		};
	}
	function pickTwitchStream(streams, preferredLogins) {
		if (streams.length === 0) return;
		for (const preferred of preferredLogins) {
			const stream = streams.find((candidate) => isPreferredMatch(candidate, preferred));
			if (stream) return {
				stream,
				reason: "preferred"
			};
		}
		return pickFromPool(streams, "doubleArpDrops", (stream) => isDoubleArp(stream) && hasDropsInTitle(stream)) ?? pickFromPool(streams, "doubleArp", isDoubleArp) ?? pickFromPool(streams, "drops", hasDropsInTitle) ?? pickFromPool(streams, "random", () => true);
	}
	function doubleArpGroupLabel(stream) {
		if (stream.group === "featured") return "Featured";
		if (stream.group === "nexus") return "Nexus";
		return "Hive";
	}
	function pickReasonLabel(pick) {
		if (pick.reason === "preferred") return "preferred";
		if (pick.reason === "doubleArpDrops") return `${doubleArpGroupLabel(pick.stream)}, 2x ARP, drops`;
		if (pick.reason === "doubleArp") return `${doubleArpGroupLabel(pick.stream)}, 2x ARP`;
		if (pick.reason === "drops") return "drops";
		return "random";
	}
	function isQuestsPage() {
		let path = location.pathname;
		while (path.endsWith("/") && path.length > 1) path = path.slice(0, -1);
		return path.endsWith("/quests") && !path.includes("/steam/quests");
	}
	async function loadTwitchStreamsDocument() {
		if (isQuestsPage()) return document;
		try {
			const response = await fetch(QUESTS_PATH, { headers: { Accept: "text/html" } });
			if (!response.ok) return;
			return new DOMParser().parseFromString(await response.text(), "text/html");
		} catch (error) {
			console.warn("[AWA Toolkit] Failed to fetch Twitch streams", error);
			return;
		}
	}
	async function handleOpenTwitchStream() {
		const settings = await getArtifactSettings();
		const questsDocument = await loadTwitchStreamsDocument();
		if (!questsDocument) {
			await showAoAlert("Could not load the Quests page to find live Twitch streams.");
			return;
		}
		const pick = pickTwitchStream(scrapeLiveTwitchStreams(questsDocument), settings.preferredTwitchStreamers);
		if (!pick) {
			await showAoAlert("No live participating Twitch streams were listed. Try again when someone is online.");
			return;
		}
		showAoToast(`Opening ${pick.stream.displayName} (${pickReasonLabel(pick)})`);
		await _GM.openInTab(pick.stream.url, { active: true });
	}
	function bindOpenTwitchButtons(root) {
		for (const button of root.querySelectorAll(".ao-twitch-btn")) button.addEventListener("click", () => {
			if (button.disabled) return;
			button.disabled = true;
			const previous = button.textContent;
			button.textContent = "Picking…";
			handleOpenTwitchStream().finally(() => {
				button.disabled = false;
				button.textContent = previous ?? "Open stream";
			});
		});
	}
	async function persistFormSettings(root) {
		const settings = await getArtifactSettings();
		const activities = { ...settings.activities };
		for (const key of Object.keys(activities)) {
			const enabled = root.querySelector(`input[data-activity="${CSS.escape(key)}"]`)?.checked;
			const frequencyRaw = root.querySelector(`input[data-freq="${CSS.escape(key)}"]`)?.value ?? "";
			const frequency = Number(frequencyRaw);
			activities[key] = {
				enabled: enabled ?? activities[key].enabled,
				frequency: frequencyRaw.trim() === "" || Number.isNaN(frequency) ? activities[key].frequency : frequency
			};
		}
		const vaultInput = root.querySelector("#ao-vault-price");
		const fragsRaw = root.querySelector("#ao-manual-frags")?.value ?? "";
		const patch = { activities };
		if (vaultInput) {
			const vault = Number(vaultInput.value);
			patch.pendingVaultPurchaseArp = Number.isNaN(vault) ? 0 : vault;
		}
		const parsedFrags = Number(fragsRaw);
		if (fragsRaw.trim() !== "" && !Number.isNaN(parsedFrags)) patch.manualFragments = parsedFrags;
		const twitchInput = root.querySelector("#ao-preferred-twitch");
		if (twitchInput) patch.preferredTwitchStreamers = parsePreferredTwitchStreamers(twitchInput.value);
		const cutoffInput = root.querySelector("#ao-utc-daily-cutoff");
		if (cutoffInput) {
			const cutoff = Number(cutoffInput.value);
			patch.utcDailyEndBufferHours = Number.isNaN(cutoff) ? settings.utcDailyEndBufferHours : clampUtcDailyEndBufferHours(cutoff);
		}
		await saveArtifactSettings(patch);
	}
	async function confirmAndApplyLoadout(result, settings) {
		await confirmAndApplyCombo(result.best, result.current, settings, "recommended", result);
	}
	async function confirmAndApplyCombo(combo, current, settings, label, result) {
		if (!await didAllowAccountActions()) return;
		if (!combo || combo.artifacts.length === 0) {
			await showAoAlert(`No ${label} loadout available.`);
			return;
		}
		const resolved = await resolveLoadoutPlan(combo, current, settings, label, result);
		if (!resolved) return;
		const currentlyEquipped = (current?.artifacts ?? []).filter((a) => a.equippedPosition !== void 0).map((a) => ({
			artifactId: a.instanceId,
			position: a.equippedPosition
		}));
		const { allOk, results, applied } = await applyLoadout(resolved.now, currentlyEquipped);
		if (allOk) {
			if (applied.length > 0) await confirmShowroomLoadout(applied);
			notifyLoadoutResult(true, results, label);
			return;
		}
		if (applied.length > 0) {
			await confirmShowroomLoadout(applied);
			notifyLoadoutResult(false, results, label);
			return;
		}
		const { snapshot, didChange } = await resyncShowroomSnapshot();
		await reloadOptimizerFromCache();
		if (snapshot !== void 0 && resolved.now.every((target) => snapshot.artifacts.some((artifact) => artifact.instanceId === target.artifactId && artifact.equippedPosition === target.position))) {
			showAoToast("Those artifacts were already equipped. Recommendations updated.");
			return;
		}
		if (didChange) {
			showAoToast("Showroom was out of date. Recommendations updated.");
			return;
		}
		notifyLoadoutResult(false, results, label);
	}
	function namedLoadout(label, activeSetNames) {
		if (!activeSetNames || activeSetNames.length === 0) return label;
		return `${label} (${activeSetNames.join(", ")})`;
	}
	async function explainNothingToEquip(label, plan, settings, options) {
		const named = namedLoadout(label, options?.activeSetNames);
		const lines = [];
		if (plan.later.length > 0) {
			lines.push(`No unlocked slots for ${named} yet.`);
			if (plan.laterNames.length > 0) lines.push(`Still needed: ${plan.laterNames.join(", ")}.`);
		} else if (options?.allArpLabel) lines.push(`The ${named} loadout is already equipped.`, `All-ARP% still needed:\n${options.allArpLabel}`);
		else lines.push(`The ${named} loadout is already equipped.`);
		if (plan.lockedSlots.length > 0) {
			const parts = formatLockedSlotParts(settings, plan.lockedSlots, options?.slotLocks);
			lines.push(`Slots on cooldown: ${parts.join(", ")}.`);
		}
		lines.push("Use Refresh if lock icons look out of date.");
		await showAoAlert(lines.join("\n\n"));
	}
	function allArpTargetArtifacts(result) {
		const deferred = result?.deferredAllArp?.artifacts;
		if (deferred && deferred.length > 0) return deferred;
		const loadout = result?.allArpLoadout?.artifacts;
		if (loadout && loadout.length > 0) return loadout;
	}
	async function resolveAllArpWhenRecommendedEquipped(current, settings, result, recommendedPlan) {
		const allArp = allArpTargetArtifacts(result);
		if (!allArp || isSameLoadout(current?.artifacts, allArp)) {
			await explainNothingToEquip("recommended", recommendedPlan, settings, {
				activeSetNames: loadoutSetNames(current?.artifacts),
				...result?.slotLocks && { slotLocks: result.slotLocks }
			});
			return;
		}
		const allArpLabel = loadoutLabel(allArp);
		const allArpSetNames = loadoutSetNames(allArp);
		const unlockedPlan = planLoadoutChanges(allArp, current, settings, result?.slotLocks);
		if (unlockedPlan.now.length > 0) return await didConfirmNormalEquip(unlockedPlan, "All-ARP%", settings, {
			activeSetNames: allArpSetNames,
			...result?.slotLocks && { slotLocks: result.slotLocks }
		}) ? unlockedPlan : void 0;
		await explainNothingToEquip("recommended", unlockedPlan, settings, {
			allArpLabel: namedLoadout(allArpLabel, allArpSetNames),
			activeSetNames: loadoutSetNames(current?.artifacts),
			...result?.slotLocks && { slotLocks: result.slotLocks }
		});
	}
	async function resolveLoadoutPlan(combo, current, settings, label, result) {
		const plan = planLoadoutChanges(combo.artifacts, current, settings, result?.slotLocks);
		const activeSetNames = loadoutSetNames(combo.artifacts);
		if (plan.now.length > 0) return await didConfirmNormalEquip(plan, label, settings, {
			activeSetNames,
			...result?.slotLocks && { slotLocks: result.slotLocks }
		}) ? plan : void 0;
		if (plan.later.length > 0) {
			await explainNothingToEquip(label, plan, settings, {
				activeSetNames,
				...result?.slotLocks && { slotLocks: result.slotLocks }
			});
			return;
		}
		if (label === "recommended") return resolveAllArpWhenRecommendedEquipped(current, settings, result, plan);
		await explainNothingToEquip(label, plan, settings, {
			activeSetNames,
			...result?.slotLocks && { slotLocks: result.slotLocks }
		});
	}
	async function didConfirmNormalEquip(plan, label, settings, options) {
		const nowLines = plan.now.map((change) => {
			const incoming = `${change.displayName} → slot ${change.position}`;
			return change.replacedDisplayName ? `${incoming} (removing ${change.replacedDisplayName})` : incoming;
		}).join("\n");
		const lockedNote = plan.lockedSlots.length > 0 ? `\n\nLeaving locked as-is: ${formatLockedSlotParts(settings, plan.lockedSlots, options?.slotLocks).join(", ")}.` : "";
		const laterNote = plan.laterNames.length > 0 ? `\nStill needed later: ${plan.laterNames.join(", ")}.` : "";
		return didConfirmAoDialog(`Equip ${namedLoadout(label, options?.activeSetNames)} into unlocked slot(s) now?\n\n${nowLines}${lockedNote}${laterNote}\n\nThis uses the live AWA API and starts a 24h cooldown per changed slot.`, {
			title: "Equip loadout",
			confirmLabel: "Equip"
		});
	}
	function notifyLoadoutResult(isOk, results, label = "recommended") {
		const succeeded = results.filter((result) => result.ok).length;
		if (isOk) {
			if (results.length === 0) {
				showAoAlert(`The ${label} loadout is already equipped.`);
				return;
			}
			showAoToast("Loadout applied. Reloading…");
			location.reload();
			return;
		}
		if (succeeded > 0) {
			showAoToast("Partial loadout applied. Reloading…");
			location.reload();
			return;
		}
		const failed = results.find((r) => !r.ok);
		showAoAlert(`Failed to apply loadout: ${failed?.error ?? failed?.message ?? "Unknown error (slot may be locked for 24h)"}`);
	}
	async function handleAddManual(root) {
		const familyId = root.querySelector("#ao-manual-family")?.value;
		if (!familyId) return;
		const tier = Number(root.querySelector("#ao-manual-tier")?.value);
		await saveArtifactSettings({
			manualArtifacts: [...(await getArtifactSettings()).manualArtifacts, {
				familyId,
				tier
			}],
			preferScraped: false
		});
	}
	async function handleRemoveManual(index) {
		await saveArtifactSettings({ manualArtifacts: (await getArtifactSettings()).manualArtifacts.filter((_, itemIndex) => itemIndex !== index) });
	}
	async function showLoadoutPreview(combo, label) {
		if (!combo || combo.artifacts.length === 0) {
			await showAoAlert(`No ${label} loadout available.`);
			return;
		}
		await showAoAlert(`Equip these on the Showroom:\n\n${sortArtifactsForDisplay(combo.artifacts).map((artifact) => artifact.displayName).join("\n")}`, label);
	}
	async function handleUpgradeClick(instanceId, onChanged) {
		if (!await didAllowAccountActions()) return;
		if (!await didConfirmAoDialog("Upgrade this artifact? This spends fragments and cannot be undone.", {
			title: "Upgrade artifact",
			confirmLabel: "Upgrade",
			isDanger: true
		})) return;
		const upgradeResult = await upgradeArtifact(instanceId);
		if (!upgradeResult.ok) {
			await showAoAlert(`Upgrade failed: ${upgradeResult.error ?? upgradeResult.status}`);
			return;
		}
		await applySnapshotUpgrade(instanceId);
		showAoToast("Artifact upgraded.");
		await onChanged();
		if (isControlCenterPage()) injectControlCenterPanel({ force: true });
		else if (isArtifactsShowroomPage()) injectShowroomPanel({ force: true });
	}
	function syncNotifyTypesEnabled(root, isMasterOn) {
		const types = root.querySelector(".ao-notify-types");
		if (!(types instanceof HTMLElement)) return;
		if (isMasterOn) {
			delete types.dataset.off;
			return;
		}
		types.dataset.off = "";
	}
	function bindNotificationTypeSwitches(root) {
		for (const key of NOTIFICATION_TYPE_KEYS) root.querySelector(`#ao-notify-type-${CSS.escape(key)}`)?.addEventListener("change", (event) => {
			const input = event.currentTarget;
			if (!(input instanceof HTMLInputElement)) return;
			saveNotificationType(key, input.checked);
		});
	}
	function notificationBlockedHelp() {
		return [
			"The browser blocked notifications, or the test ping did not appear.",
			"",
			"1. If a permission popup appeared, click Allow.",
			`2. ${/Mac|iPhone|iPad/i.test(navigator.userAgent) ? "Open System Settings → Notifications. Find your browser (Zen, Firefox, Chrome, or Edge) and allow notifications." : "Open your system notification settings and allow this browser."}`,
			"3. Flip Desktop notifications on again."
		].join("\n");
	}
	function bindDynamicBody(root, onChanged) {
		root.querySelector("#ao-account-actions")?.addEventListener("change", (event) => {
			const input = event.currentTarget;
			if (!(input instanceof HTMLInputElement)) return;
			(async () => {
				if (!input.checked) {
					await saveArtifactSettings({ allowAccountActions: false });
					await reloadOptimizerFromCache();
					return;
				}
				if (!await didConfirmAoDialog([
					"This lets AWA Toolkit change your equipped artifacts, spend fragments on upgrades, and claim Battle Pass rewards using the site APIs.",
					"",
					"Use at your own risk."
				].join("\n"), {
					title: "Enable account actions?",
					confirmLabel: "Enable",
					isDanger: true
				})) {
					input.checked = false;
					return;
				}
				await saveArtifactSettings({ allowAccountActions: true });
				await reloadOptimizerFromCache();
			})();
		});
		root.querySelector("#ao-browser-notifications")?.addEventListener("change", (event) => {
			const input = event.currentTarget;
			if (!(input instanceof HTMLInputElement)) return;
			(async () => {
				if (!input.checked) {
					await didSetBrowserNotifications(false);
					syncNotifyTypesEnabled(root, false);
					return;
				}
				if (!isNotificationPermissionGranted()) {
					if (!await didConfirmAoDialog([
						"AWA Toolkit can ping you when:",
						"",
						"• A recommended swap is ready after a 24h lock",
						"• Community hours unlock",
						"• Game Vault opens or new games appear",
						"• A new official key giveaway is posted",
						"",
						"Your browser will ask for permission next. Click Allow.",
						"",
						"You should then see a test notification. If you do not, we will show how to turn them on in system settings."
					].join("\n"), {
						title: "Enable desktop notifications?",
						confirmLabel: "Enable"
					})) {
						input.checked = false;
						return;
					}
				}
				if (await didSetBrowserNotifications(true, gatheredCache.current)) {
					syncNotifyTypesEnabled(root, true);
					return;
				}
				input.checked = false;
				await didSetBrowserNotifications(false);
				syncNotifyTypesEnabled(root, false);
				await showAoAlert(notificationBlockedHelp(), "Notifications blocked");
			})();
		});
		bindNotificationTypeSwitches(root);
		root.querySelector("#ao-add-manual")?.addEventListener("click", () => {
			handleAddManual(root).then(onChanged);
		});
		for (const button of root.querySelectorAll(".ao-remove-manual")) button.addEventListener("click", () => {
			handleRemoveManual(Number(button.dataset.index)).then(onChanged);
		});
		bindUpgradeButtons(root, onChanged);
		bindClaimAllButtons(root);
		bindOpenTwitchButtons(root);
		bindVaultDiscountActions(root, onChanged);
	}
	function bindUpgradeButtons(root, onChanged) {
		for (const button of root.querySelectorAll(".ao-upgrade-btn")) button.addEventListener("click", () => {
			handleUpgradeClick(Number(button.dataset.id), onChanged);
		});
	}
	function ensureOptimizerBackdrop() {
		let backdrop = document.querySelector(`#${BACKDROP_ID}`);
		if (!backdrop) {
			backdrop = document.createElement("div");
			backdrop.id = BACKDROP_ID;
			backdrop.style.setProperty("display", "none", "important");
			applyOpaqueBackdropChrome(backdrop);
			backdrop.addEventListener("click", () => {
				setOptimizerModalOpen(false);
			});
			document.body.append(backdrop);
		}
		return backdrop;
	}
	function setOptimizerModalOpen(isOpen) {
		const modal = document.querySelector(`#${MODAL_ID}`);
		const backdrop = ensureOptimizerBackdrop();
		if (!modal) {
			backdrop.style.setProperty("display", "none", "important");
			return;
		}
		modal.hidden = !isOpen;
		if (isOpen) {
			applyOpaqueModalChrome(modal);
			applyOpaqueBackdropChrome(backdrop);
			modal.style.setProperty("display", "block", "important");
			backdrop.style.setProperty("display", "block", "important");
		} else {
			modal.style.setProperty("display", "none", "important");
			backdrop.style.setProperty("display", "none", "important");
			hideArtifactTip();
		}
	}
	function panelTree(root) {
		return root.shadowRoot ?? root;
	}
	function modalTree(modal) {
		return panelTree(modal);
	}
	function resolveShowroomInsertTarget() {
		let target = [...document.querySelectorAll("div, p, span")].find((element) => /^Fragments:\s*\d+/i.test(element.textContent?.trim() ?? "")) ?? document.querySelector("#weapon-section") ?? void 0;
		if (!target) return;
		const link = target.closest("a");
		if (link) target = link;
		const parent = target.parentElement;
		if (!parent) return;
		return {
			parent,
			before: target.nextSibling
		};
	}
	function bindModalEvents(modal, initial) {
		let cache = initial;
		const tree = () => modalTree(modal);
		bindArtifactTips(modal.shadowRoot ?? modal);
		const paint = (data, options = {}) => {
			cache = data;
			const body = tree().querySelector("#ao-body");
			if (!body) return;
			hideArtifactTip();
			body.innerHTML = renderResultBody(cache.result, cache.snapshot, cache.settings, cache.siteState, { isHydrating: options.isHydrating === true });
			const equipButton = tree().querySelector("#ao-equip");
			if (equipButton instanceof HTMLButtonElement) equipButton.hidden = !areAccountActionsEnabled(cache.settings);
			bindDynamicBody(body, () => refreshView());
		};
		const refreshView = async (options) => {
			const isRemote = options?.remote ?? true;
			const isForce = options?.force ?? false;
			if (options?.persist === true) await persistFormSettings(tree());
			const cached = await gatherData({ remote: false });
			const shouldHydrate = isRemote && (isForce || requiresBackgroundHydrate(cached, { force: isForce }));
			paint(cached, { isHydrating: shouldHydrate });
			if (!shouldHydrate) return;
			paint(await hydrateGatheredData({ force: isForce }), { isHydrating: false });
			syncControlCenterFromGathered();
		};
		tree().querySelector("#ao-close")?.addEventListener("click", () => {
			setOptimizerModalOpen(false);
		});
		tree().querySelector("#ao-save")?.addEventListener("click", () => {
			(async () => {
				await persistFormSettings(tree());
				await refreshView({ persist: false });
				showAoToast("Settings saved.");
			})();
		});
		tree().querySelector("#ao-equip")?.addEventListener("click", () => {
			confirmAndApplyLoadout(cache.result, cache.settings);
		});
		tree().querySelector("#ao-refresh")?.addEventListener("click", () => {
			refreshView({ force: true });
		});
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && !modal.hidden) setOptimizerModalOpen(false);
		});
		paint(initial, { isHydrating: requiresBackgroundHydrate(initial) });
		modal.__aoRefresh = refreshView;
	}
	function destroyOptimizerModal() {
		document.querySelector(`#${MODAL_ID}`)?.remove();
		document.querySelector(`#${BACKDROP_ID}`)?.remove();
	}
	async function createOptimizerModal() {
		destroyOptimizerModal();
		ensureOptimizerStyles();
	}
	async function openOptimizerModal() {
		ensureOptimizerStyles();
		let modal = document.querySelector(`#alienware-artifact-optimizer`) ?? void 0;
		if (modal && !modal.shadowRoot) {
			modal.remove();
			modal = void 0;
		}
		const isNew = !modal;
		if (!modal) {
			const shell = document.createElement("div");
			shell.id = MODAL_ID;
			shell.setAttribute("role", "dialog");
			shell.setAttribute("aria-modal", "true");
			shell.setAttribute("aria-labelledby", "ao-title");
			shell.hidden = true;
			const shadow = shell.attachShadow({ mode: "open" });
			shadow.innerHTML = `
      <style>${buildModalShadowCss()}</style>
      <div class="ao-panel">
        <div class="ao-title" id="ao-title">AWA Toolkit</div>
        ${renderCredits()}
        <div id="ao-body">
          ${renderModalSkeleton()}
        </div>
        <div class="ao-actions">
          <button type="button" id="ao-equip" hidden>Equip Recommended</button>
          <button type="button" id="ao-refresh" class="ao-secondary">Refresh</button>
          <button type="button" id="ao-save" class="ao-secondary">Save Settings</button>
          <button type="button" id="ao-close" class="ao-danger">Close</button>
        </div>
      </div>
    `;
			document.body.append(shell);
			modal = shell;
		}
		setOptimizerModalOpen(true);
		if (isNew) {
			const cached = gatheredCache.current ?? await gatherData({ remote: false });
			bindModalEvents(modal, cached);
		}
		const shouldHydrate = gatheredCache.current !== void 0 && requiresBackgroundHydrate(gatheredCache.current);
		if (shouldHydrate || !isNew) modal.__aoRefresh?.({ remote: shouldHydrate || !isNew });
	}
	function addOptimizerMenuButton() {
		const menuList = document.querySelector(".nav-item-mus .dropdown-menu.dropdown-menu-end");
		if (!menuList || menuList.querySelector("[data-ao-menu]")) return;
		const item = document.createElement("a");
		item.className = "dropdown-item";
		item.href = "#";
		item.dataset.aoMenu = "1";
		item.textContent = "Artifact Optimizer";
		item.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			openOptimizerModal();
		});
		menuList.insertBefore(item, menuList.lastElementChild);
	}
	function watchOptimizerMenuButton() {
		addOptimizerMenuButton();
		if (document.documentElement.dataset.aoMenuWatch === "1") return;
		document.documentElement.dataset.aoMenuWatch = "1";
		new MutationObserver(() => {
			if (!document.querySelector("[data-ao-menu]")) addOptimizerMenuButton();
		}).observe(document.documentElement, {
			childList: true,
			subtree: true
		});
	}
	function parkElement(element) {
		const parent = document.body ?? document.documentElement;
		if (element.parentElement !== parent) parent.prepend(element);
	}
	function findControlCenterMount() {
		return document.querySelector(".container.account.has-fixed-menu") ?? document.querySelector("main .container.account") ?? document.querySelector("main") ?? void 0;
	}
	function insertControlCenterHost(panel) {
		const container = findControlCenterMount();
		if (container) {
			if (panel.parentElement !== container) container.prepend(panel);
			return;
		}
		parkElement(panel);
	}
	function watchControlCenterHost(panel) {
		insertControlCenterHost(panel);
		if (panel.dataset.aoHostWatch === "1") return;
		panel.dataset.aoHostWatch = "1";
		new MutationObserver(() => {
			if (!panel.isConnected) {
				insertControlCenterHost(panel);
				return;
			}
			const mount = findControlCenterMount();
			if (mount && panel.parentElement !== mount && !panel.contains(mount)) insertControlCenterHost(panel);
		}).observe(document.documentElement, {
			childList: true,
			subtree: true
		});
	}
	function insertShowroomHost(panel) {
		const insert = resolveShowroomInsertTarget();
		if (!insert) {
			parkElement(panel);
			return;
		}
		if (panel.parentNode !== insert.parent) insert.parent.insertBefore(panel, insert.before);
	}
	function watchShowroomHost(panel) {
		insertShowroomHost(panel);
		if (panel.dataset.aoHostWatch === "1") return;
		panel.dataset.aoHostWatch = "1";
		new MutationObserver(() => {
			if (!panel.isConnected) {
				insertShowroomHost(panel);
				return;
			}
			const parent = panel.parentElement;
			if (parent === document.body || parent === document.documentElement) insertShowroomHost(panel);
		}).observe(document.documentElement, {
			childList: true,
			subtree: true
		});
	}
	function mountInlinePanelShadow(host, bodyHtml) {
		if (host.shadowRoot) host.shadowRoot.replaceChildren();
		const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
		shadow.innerHTML = `
    <style>${buildInlineShadowCss()}</style>
    <div class="ao-panel">
      ${bodyHtml}
    </div>
    `;
		bindArtifactTips(shadow);
		return shadow;
	}
	function replaceInlinePanelBody(panel, bodyHtml) {
		const box = panelTree(panel).querySelector(".ao-panel");
		if (box) {
			hideArtifactTip();
			box.innerHTML = bodyHtml;
			return;
		}
		mountInlinePanelShadow(panel, bodyHtml);
	}
	function bumpPanelGeneration(panel) {
		const generation = Number(panel.dataset.aoGen ?? "0") + 1;
		panel.dataset.aoGen = String(generation);
		return generation;
	}
	function isPanelGenerationCurrent(panel, generation) {
		return panel.isConnected && panel.dataset.aoGen === String(generation);
	}
	function compactLoadoutSummary(data) {
		const todos = buildActionPlan(data.result, data.settings, data.siteState);
		const isHideRecommendedEquip = isKeepingCurrentLoadout(todos) && Boolean(data.result.current);
		return {
			todos,
			combo: isHideRecommendedEquip ? data.result.current : data.result.best,
			label: isHideRecommendedEquip ? "Currently equipped" : "Recommended",
			hideRecommendedEquip: isHideRecommendedEquip
		};
	}
	function renderShowroomPanelBody(data, options = {}) {
		const hydrateBanner = options.isHydrating ? renderHydrateBanner("Updating in the background…") : "";
		const summary = compactLoadoutSummary(data);
		return `
    <div class="ao-heading">Artifact Optimizer</div>
    ${renderCredits({ compact: true })}
    ${hydrateBanner}
    <div class="ao-row"><strong>${summary.label}:</strong> ${wrapArtifactNames(comboLabel(summary.combo))}</div>
    ${renderBreakdown(summary.combo)}
    ${renderVaultDiscountBlock(data.result)}
    ${renderShowroomEquipActions(data.result, {
			hideRecommendedEquip: summary.hideRecommendedEquip,
			allowAccountActions: areAccountActionsEnabled(data.settings)
		})}
  `;
	}
	function compactClaimAllBpButton(data) {
		const shouldWait = data.result.deferBattlePassClaims === true;
		if (!shouldShowBattlePassClaimAll(data.siteState.battlePass, shouldWait)) return "";
		const shouldSkipArpBoosts = shouldSkipArpInBattlePassClaimAll(data.siteState.battlePass, shouldWait);
		return `<button type="button" class="ao-claim-btn ao-secondary"${shouldSkipArpBoosts ? " data-skip-arp=\"1\"" : ""}${shouldSkipArpBoosts ? " title=\"Claims cosmetics and fragments; leaves ARP Boosts until All-ARP% is equipped\"" : ""}>${battlePassClaimButtonLabel(shouldSkipArpBoosts, { compact: true })}</button>`;
	}
	function renderControlCenterPanelBody(data, options = {}) {
		const hydrateBanner = options.isHydrating ? renderHydrateBanner("Updating in the background…") : "";
		const summary = compactLoadoutSummary(data);
		const areActionsEnabled = areAccountActionsEnabled(data.settings);
		const equipButton = areActionsEnabled && !summary.hideRecommendedEquip ? "<button type=\"button\" id=\"ao-cc-equip\">Equip Recommended</button>" : "";
		const claimBpButton = areActionsEnabled ? compactClaimAllBpButton(data) : "";
		const actionsOffNote = areActionsEnabled ? "" : "<div class=\"ao-muted\">Account actions are off — enable in Open Full Panel.</div>";
		return `
    <div class="ao-heading">Artifact Optimizer</div>
    ${renderCredits({ compact: true })}
    ${hydrateBanner}
    ${renderActionPlan(summary.todos, { allowAccountActions: areActionsEnabled })}
    ${renderSectionDivider()}
    <div class="ao-row"><strong>${summary.label}:</strong> ${wrapArtifactNames(comboLabel(summary.combo))}</div>
    ${renderBreakdown(summary.combo)}
    ${renderCooldownBlock(data.settings, data.snapshot?.slotLocks)}
    ${renderVaultDiscountBlock(data.result)}
    ${supplementalNotes(data.result.notes).map((note) => `<div class="ao-note">${wrapArtifactNames(note)}</div>`).join("")}
    ${actionsOffNote}
    <div class="ao-actions">
      ${equipButton}
      ${equipButton ? "<span class=\"ao-actions-sep\" aria-hidden=\"true\"></span>" : ""}
      ${claimBpButton}
      <button type="button" id="ao-cc-open" class="ao-secondary">Open Full Panel</button>
      <button type="button" id="ao-cc-artifacts" class="ao-secondary">Go to Artifacts</button>
      <button type="button" id="ao-cc-refresh" class="ao-secondary">Refresh</button>
    </div>
  `;
	}
	function ensureControlCenterHost() {
		const existing = document.querySelector(`#${CC_PANEL_ID}`);
		if (existing) {
			watchControlCenterHost(existing);
			return existing;
		}
		const panel = document.createElement("div");
		panel.id = CC_PANEL_ID;
		mountInlinePanelShadow(panel, renderPanelSkeleton());
		watchControlCenterHost(panel);
		return panel;
	}
	function ensureShowroomHost() {
		const existing = document.querySelector(`#${INLINE_ID}`);
		if (existing) {
			watchShowroomHost(existing);
			return existing;
		}
		const panel = document.createElement("div");
		panel.id = INLINE_ID;
		mountInlinePanelShadow(panel, renderPanelSkeleton());
		watchShowroomHost(panel);
		return panel;
	}
	async function refreshPanelFromLivePage(panel, generation, paint) {
		if (isControlCenterPage()) {
			await waitForControlCenterDocument();
			if (!isPanelGenerationCurrent(panel, generation)) return;
			insertControlCenterHost(panel);
		} else if (isArtifactsShowroomPage()) {
			await waitForShowroomDocument();
			if (!isPanelGenerationCurrent(panel, generation)) return;
			insertShowroomHost(panel);
		} else return;
		const live = await gatherData({ remote: false });
		if (!isPanelGenerationCurrent(panel, generation)) return;
		paint(live, false);
	}
	function formatPanelLoadError(error) {
		return error instanceof Error ? error.message : String(error);
	}
	async function fillPanelFromCacheThenHydrate(panel, generation, paint, options = {}) {
		try {
			if (options.force === true) {
				const cached = gatheredCache.current ?? await gatherData({ remote: false });
				if (!isPanelGenerationCurrent(panel, generation)) return;
				paint(cached, true);
				const hydrated = await hydrateGatheredData({ force: true });
				if (!isPanelGenerationCurrent(panel, generation)) return;
				paint(hydrated, false);
				return;
			}
			const cached = await gatherData({ remote: false });
			if (!isPanelGenerationCurrent(panel, generation)) return;
			const shouldHydrate = requiresBackgroundHydrate(cached, options);
			paint(cached, shouldHydrate);
			await refreshPanelFromLivePage(panel, generation, (data, isHydrating) => {
				paint(data, shouldHydrate || isHydrating);
			});
			if (!shouldHydrate) return;
			const hydrated = await hydrateGatheredData(options);
			if (!isPanelGenerationCurrent(panel, generation)) return;
			paint(hydrated, false);
		} catch (error) {
			console.error("[AWA Toolkit] Failed to load recommendations", error);
			if (!isPanelGenerationCurrent(panel, generation)) return;
			replaceInlinePanelBody(panel, renderPanelError(formatPanelLoadError(error)));
		}
	}
	function renderShowroomLoadoutButton(options) {
		if (!options.combo) return "";
		const names = comboLabel(options.combo);
		if (options.allowAccountActions) {
			const className = options.isPrimary === true ? "" : " class=\"ao-secondary\"";
			return `<button type="button" id="${options.id}"${className} title="${escapeHtml(names)}">Equip ${escapeHtml(options.role)}</button>`;
		}
		return `<button type="button" id="${options.id}" class="ao-secondary ao-loadout-preview">${escapeHtml(options.role)}: ${wrapArtifactNames(names)}</button>`;
	}
	function renderShowroomEquipActions(result, options = {}) {
		const areActionsEnabled = options.allowAccountActions === true;
		const recommended = options.hideRecommendedEquip ? "" : renderShowroomLoadoutButton({
			id: "ao-inline-equip",
			role: "Recommended",
			combo: result.best,
			allowAccountActions: areActionsEnabled,
			isPrimary: true
		});
		const allArp = renderShowroomLoadoutButton({
			id: "ao-inline-equip-allarp",
			role: "All-ARP%",
			combo: result.allArpLoadout,
			allowAccountActions: areActionsEnabled
		});
		const monthlyMeta = renderShowroomLoadoutButton({
			id: "ao-inline-equip-monthly",
			role: "Monthly META",
			combo: result.monthlyMetaLoadout,
			allowAccountActions: areActionsEnabled
		});
		const market = renderShowroomLoadoutButton({
			id: "ao-inline-equip-market",
			role: "Market Discount",
			combo: result.marketDiscountLoadout,
			allowAccountActions: areActionsEnabled
		});
		return `
    <div class="ao-actions">
      ${recommended}
      ${allArp}
      ${monthlyMeta}
      ${market}
      ${[
			recommended,
			allArp,
			monthlyMeta,
			market
		].some((html) => html.length > 0) ? "<span class=\"ao-actions-sep\" aria-hidden=\"true\"></span>" : ""}
      <button type="button" id="ao-inline-open" class="ao-secondary">Open Full Panel</button>
    </div>
  `;
	}
	async function injectShowroomPanel(options = {}) {
		if (!isArtifactsShowroomPage()) return;
		ensureOptimizerStyles();
		const panel = ensureShowroomHost();
		if (panel.dataset.aoReady === "1" && options.force !== true) return;
		const generation = bumpPanelGeneration(panel);
		const paint = (data, isHydrating) => {
			replaceInlinePanelBody(panel, renderShowroomPanelBody(data, { isHydrating }));
			bindShowroomPanelActions(panel, data);
			bindVaultDiscountActions(panelTree(panel), () => {
				injectShowroomPanel({ force: true });
			});
		};
		await fillPanelFromCacheThenHydrate(panel, generation, paint, options);
		if (isPanelGenerationCurrent(panel, generation)) panel.dataset.aoReady = "1";
	}
	function paintControlCenterPanel(panel, data, isHydrating) {
		replaceInlinePanelBody(panel, renderControlCenterPanelBody(data, { isHydrating }));
		bindInlinePanelActions(panel, data, {
			equipId: "ao-cc-equip",
			openId: "ao-cc-open"
		});
		bindUpgradeButtons(panelTree(panel), async () => {});
		bindClaimAllButtons(panelTree(panel));
		bindOpenTwitchButtons(panelTree(panel));
		bindVaultDiscountActions(panelTree(panel), () => {
			injectControlCenterPanel({ force: true });
		});
		panelTree(panel).querySelector("#ao-cc-artifacts")?.addEventListener("click", () => {
			location.assign("/user-artifacts-room");
		});
		panelTree(panel).querySelector("#ao-cc-refresh")?.addEventListener("click", () => {
			injectControlCenterPanel({ force: true });
		});
	}
	function syncControlCenterFromGathered() {
		if (!isControlCenterPage() || !gatheredCache.current) return;
		const panel = document.querySelector(`#${CC_PANEL_ID}`);
		if (!panel?.shadowRoot) return;
		paintControlCenterPanel(panel, gatheredCache.current, false);
	}
	async function injectControlCenterPanel(options = {}) {
		if (!isControlCenterPage()) return;
		ensureOptimizerStyles();
		const panel = ensureControlCenterHost();
		if (panel.dataset.aoReady === "1" && options.force !== true) return;
		const generation = bumpPanelGeneration(panel);
		const paint = (data, isHydrating) => {
			paintControlCenterPanel(panel, data, isHydrating);
		};
		await fillPanelFromCacheThenHydrate(panel, generation, paint, options);
		if (isPanelGenerationCurrent(panel, generation)) panel.dataset.aoReady = "1";
	}
	async function reloadOptimizerFromCache() {
		const ccPanel = document.querySelector(`#${CC_PANEL_ID}`);
		if (ccPanel) delete ccPanel.dataset.aoReady;
		const showroomPanel = document.querySelector(`#${INLINE_ID}`);
		if (showroomPanel) delete showroomPanel.dataset.aoReady;
		await injectControlCenterPanel();
		await injectShowroomPanel();
		await document.querySelector(`#${MODAL_ID}`)?.__aoRefresh?.({ remote: false });
	}
	var DEFAULT_INLINE_PANEL_IDS = {
		equipId: "ao-inline-equip",
		openId: "ao-inline-open"
	};
	function bindShowroomPanelActions(panel, data) {
		const tree = panelTree(panel);
		const areActionsEnabled = areAccountActionsEnabled(data.settings);
		const bindLoadoutButton = (id, combo, label) => {
			tree.querySelector(id)?.addEventListener("click", () => {
				if (areActionsEnabled) {
					confirmAndApplyCombo(combo, data.result.current, data.settings, label);
					return;
				}
				showLoadoutPreview(combo, label);
			});
		};
		bindLoadoutButton("#ao-inline-equip", data.result.best, "recommended");
		bindLoadoutButton("#ao-inline-equip-allarp", data.result.allArpLoadout, "All-ARP%");
		bindLoadoutButton("#ao-inline-equip-monthly", data.result.monthlyMetaLoadout, "monthly META");
		bindLoadoutButton("#ao-inline-equip-market", data.result.marketDiscountLoadout, "market discount");
		tree.querySelector("#ao-inline-open")?.addEventListener("click", () => {
			openOptimizerModal();
		});
	}
	function bindInlinePanelActions(panel, data, ids = DEFAULT_INLINE_PANEL_IDS) {
		const tree = panelTree(panel);
		tree.querySelector(`#${ids.equipId}`)?.addEventListener("click", () => {
			confirmAndApplyLoadout(data.result, data.settings);
		});
		tree.querySelector(`#${ids.openId}`)?.addEventListener("click", () => {
			openOptimizerModal();
		});
	}
	function renderBattlePassClaimBarBody() {
		const live = scrapeBattlePassFromDocument(document);
		const cached = gatheredCache.current;
		const battlePass = live ?? cached?.siteState.battlePass;
		const count = live?.readyToClaim ?? (listBattlePassClaimButtons().length || battlePass?.readyToClaim || 0);
		if (count <= 0) return `
      <div class="ao-heading">Battle Pass</div>
      <div class="ao-muted">No rewards waiting to claim</div>
    `;
		const shouldWait = cached === void 0 ? (battlePass?.readyToClaimArp ?? 0) > 0 : cached.result.deferBattlePassClaims === true;
		const shouldShowClaimAll = shouldShowBattlePassClaimAll(battlePass, shouldWait);
		const shouldSkipArpBoosts = shouldSkipArpInBattlePassClaimAll(battlePass, shouldWait);
		const skipArp = shouldSkipArpBoosts ? " data-skip-arp=\"1\"" : "";
		const areActionsEnabled = cached !== void 0 && areAccountActionsEnabled(cached.settings);
		let claimButton = "<div class=\"ao-muted\">Wait to claim ARP Boosts until All-ARP% is equipped</div>";
		if (shouldShowClaimAll && areActionsEnabled) claimButton = `<div class="ao-actions"><button type="button" class="ao-claim-btn"${skipArp}>${battlePassClaimButtonLabel(shouldSkipArpBoosts)}</button></div>`;
		else if (shouldShowClaimAll) claimButton = "";
		return `
    <div class="ao-heading">Battle Pass</div>
    <div class="ao-row"><strong>${count} ready to claim</strong></div>
    ${claimButton}
  `;
	}
	async function paintBattlePassClaimBar() {
		if (!gatheredCache.current) await gatherData({ remote: false });
		const panel = document.querySelector(`#${BP_CLAIM_BAR_ID}`);
		if (!panel?.shadowRoot) return;
		replaceInlinePanelBody(panel, renderBattlePassClaimBarBody());
		bindClaimAllButtons(panelTree(panel));
	}
	function injectBattlePassClaimBar() {
		ensureOptimizerStyles();
		let panel = document.querySelector(`#${BP_CLAIM_BAR_ID}`);
		if (!panel) {
			panel = document.createElement("div");
			panel.id = BP_CLAIM_BAR_ID;
			mountInlinePanelShadow(panel, renderBattlePassClaimBarBody());
		}
		insertControlCenterHost(panel);
		bindClaimAllButtons(panelTree(panel));
	}
	async function initArtifactOptimizer() {
		ensureOptimizerStyles();
		watchOptimizerMenuButton();
		if (isControlCenterPage()) {
			ensureControlCenterHost();
			injectControlCenterPanel();
			watchControlCenterPage(async (state) => {
				await applyAsceCommunityHours(state);
				await saveSiteState(state);
				const panel = document.querySelector(`#${CC_PANEL_ID}`);
				if (!panel?.shadowRoot) return;
				paintControlCenterPanel(panel, await gatherData({ remote: false }), false);
			});
		} else if (isArtifactsShowroomPage()) {
			ensureShowroomHost();
			injectShowroomPanel();
		} else if (isSiteStatePage()) {
			if (location.pathname.includes("/battle-pass")) {
				injectBattlePassClaimBar();
				watchBattlePassPage(async (state) => {
					await applyAsceCommunityHours(state);
					await saveSiteState(state);
					await paintBattlePassClaimBar();
				});
				(async () => {
					await waitForBattlePassDocument();
					await paintBattlePassClaimBar();
					await consumePendingBattlePassClaimAll();
					await paintBattlePassClaimBar();
				})();
			} else if (location.pathname.includes("/arp-log")) watchArpLogPage(async (state) => {
				await applyAsceCommunityHours(state);
				await saveSiteState(state);
			});
			else (async () => {
				const state = await refreshSiteStateFromPage();
				await applyAsceCommunityHours(state);
				await saveSiteState(state);
			})();
		}
		await createOptimizerModal();
		warmNotificationSchedule();
	}
	var defaultSettings = {
		higherTier: "hide",
		autoSyncTier: true,
		outOfStock: "hide",
		claimed: "hide",
		closedGiveaways: "hide",
		enteredGiveaways: "hide"
	};
	var FILTER_MODES = new Set([
		"off",
		"dim",
		"hide"
	]);
	function isFilterMode(value) {
		return typeof value === "string" && FILTER_MODES.has(value);
	}
	function isSettingsRecord(value) {
		return typeof value === "object" && value !== null;
	}
	function filterModeFromSaved(parsed, modeKey, legacyHideKey, fallback) {
		if (isFilterMode(parsed[modeKey])) return parsed[modeKey];
		const legacyHide = parsed[legacyHideKey];
		if (typeof legacyHide === "boolean") return legacyHide ? "hide" : "off";
		return fallback;
	}
	async function getSettings() {
		const savedSettings = await _GM.getValue("filterSettings");
		const settings = { ...defaultSettings };
		if (!savedSettings) return settings;
		try {
			const parsedUnknown = typeof savedSettings === "string" ? JSON.parse(savedSettings) : savedSettings;
			if (!isSettingsRecord(parsedUnknown)) return settings;
			const parsed = parsedUnknown;
			settings.higherTier = filterModeFromSaved(parsed, "higherTier", "hideTierRestricted", defaultSettings.higherTier);
			settings.outOfStock = filterModeFromSaved(parsed, "outOfStock", "hideOutOfStock", defaultSettings.outOfStock);
			settings.claimed = filterModeFromSaved(parsed, "claimed", "hideClaimed", defaultSettings.claimed);
			settings.closedGiveaways = filterModeFromSaved(parsed, "closedGiveaways", "hideClosedGiveaways", defaultSettings.closedGiveaways);
			settings.enteredGiveaways = isFilterMode(parsed.enteredGiveaways) ? parsed.enteredGiveaways : defaultSettings.enteredGiveaways;
			if (typeof parsed.autoSyncTier === "boolean") settings.autoSyncTier = parsed.autoSyncTier;
			if (parsed.userTier !== void 0) {
				const tierValue = Number(parsed.userTier);
				if (!Number.isNaN(tierValue)) settings.userTier = tierValue;
			}
		} catch (error) {
			console.error("Error parsing saved settings:", error);
			return defaultSettings;
		}
		return settings;
	}
	async function saveSettings(settings) {
		const newSettings = {
			...await getSettings(),
			...settings
		};
		await _GM.setValue("filterSettings", JSON.stringify(newSettings));
	}
	function extractTier(text) {
		const match = /Tier\s*(\d+)/i.exec(text);
		if (match?.[1]) return Number(match[1]);
	}
	function readPageUserTier() {
		return readPageArpTier();
	}
	async function checkAndStoreTier() {
		let userTier = readPageUserTier();
		if (userTier === void 0 && document.readyState !== "complete") {
			await new Promise((resolve) => {
				window.addEventListener("load", () => {
					resolve();
				}, { once: true });
			});
			userTier = readPageUserTier();
		}
		if (userTier === void 0) return;
		await saveSettings({ userTier });
		console.log("Stored user tier:", userTier);
	}
	var FILTER_STYLE_ID = "alienware-filter-styles";
	var FILTER_DIM_CLASS = "awa-filter-dimmed";
	var FILTER_STATE_ATTR = "data-awa-filter";
	function parseTimestamp(value) {
		const normalized = value.includes("T") ? value : value.replace(" ", "T");
		const ms = Date.parse(normalized);
		return Number.isNaN(ms) ? void 0 : ms;
	}
	function isGiveawayClosed(giveaway) {
		const timeElement = giveaway.querySelector(".community-giveaways__listing-row__time");
		const timeText = (timeElement?.textContent ?? "").replaceAll(/\s+/g, " ").trim();
		if (/\bclosed\b/i.test(timeText)) return true;
		const closeStamp = timeElement?.querySelector(".timeago-future")?.getAttribute("title");
		if (!closeStamp) return false;
		const closeMs = parseTimestamp(closeStamp);
		return closeMs !== void 0 && closeMs <= Date.now();
	}
	function isGiveawayEntered(giveaway) {
		return /you have entered this giveaway/i.test(giveaway.textContent ?? "");
	}
	function combineFilterMode(current, mode, isMatching) {
		if (!isMatching || mode === "off") return current;
		if (mode === "hide" || current === "hide") return "hide";
		return "dim";
	}
	function marketplaceFilterTarget(item) {
		return item.closest("[class*=\"marketplace-product-block-\"]") ?? item;
	}
	function applyFilterEffect(target, effect) {
		const previous = target.getAttribute(FILTER_STATE_ATTR);
		if (effect === "none") {
			if (previous === "hide") target.style.removeProperty("display");
			target.classList.remove(FILTER_DIM_CLASS);
			target.removeAttribute(FILTER_STATE_ATTR);
			return;
		}
		target.setAttribute(FILTER_STATE_ATTR, effect);
		target.classList.toggle(FILTER_DIM_CLASS, effect === "dim");
		if (effect === "hide") {
			target.style.display = "none";
			return;
		}
		if (previous === "hide") target.style.removeProperty("display");
	}
	function marketplaceFilterEffect(item, settings, userTier) {
		const text = item.textContent || "";
		const normalizedText = text.toLowerCase();
		let effect = "none";
		effect = combineFilterMode(effect, settings.outOfStock, normalizedText.includes("out of stock") || item.dataset.productInStock === "false");
		effect = combineFilterMode(effect, settings.claimed, normalizedText.includes("claimed"));
		const tierNumber = extractTier(text);
		effect = combineFilterMode(effect, settings.higherTier, tierNumber !== void 0 && tierNumber > userTier);
		return effect;
	}
	function giveawayFilterEffect(giveaway, settings, userTier) {
		let effect = "none";
		effect = combineFilterMode(effect, settings.closedGiveaways, isGiveawayClosed(giveaway));
		effect = combineFilterMode(effect, settings.enteredGiveaways, isGiveawayEntered(giveaway));
		const tierNumber = extractTier(giveaway.querySelector(".community-giveaways__listing-row__tier")?.textContent ?? "");
		effect = combineFilterMode(effect, settings.higherTier, tierNumber !== void 0 && tierNumber > userTier);
		return effect;
	}
	async function filterGiveaways() {
		const settings = await getSettings();
		const userTier = settings.userTier ?? 99;
		document.querySelectorAll(".community-giveaways__listing__row").forEach((giveaway) => {
			applyFilterEffect(giveaway, giveawayFilterEffect(giveaway, settings, userTier));
		});
	}
	async function filterMarketplace() {
		const settings = await getSettings();
		const userTier = settings.userTier ?? 99;
		document.querySelectorAll([
			".product-card.marketplace-product",
			".pointer.marketplace-game-small",
			".pointer.marketplace-game-large"
		].join(", ")).forEach((item) => {
			applyFilterEffect(marketplaceFilterTarget(item), marketplaceFilterEffect(item, settings, userTier));
		});
	}
	function ensureFilterStyles() {
		if (document.querySelector(`#${FILTER_STYLE_ID}`)) return;
		const style = document.createElement("style");
		style.id = FILTER_STYLE_ID;
		style.textContent = `
        .${FILTER_DIM_CLASS} {
          opacity: 0.4 !important;
          filter: grayscale(0.55);
        }
      `;
		(document.head ?? document.documentElement).append(style);
	}
	function watchPageFilters() {
		const currentPath = location.pathname;
		if (currentPath === "/community-giveaways") {
			new MutationObserver(() => {
				filterGiveaways();
			}).observe(document.body, {
				childList: true,
				subtree: true
			});
			filterGiveaways();
			return;
		}
		if (currentPath.startsWith("/marketplace")) {
			new MutationObserver(() => {
				filterMarketplace();
			}).observe(document.body, {
				childList: true,
				subtree: true
			});
			filterMarketplace();
		}
	}
	function buildSettingsMenuStyles() {
		return `
      <style>
        #alienware-filter-settings-backdrop {
          display: none;
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          z-index: 10000;
        }
        #alienware-filter-settings {
          display: none;
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: #1a1a1a !important;
          background-color: #1a1a1a !important;
          opacity: 1 !important;
          color: #fff;
          padding: 20px;
          border-radius: 8px;
          border: 1px solid #333;
          z-index: 10001;
          min-width: 320px;
          max-width: min(460px, 94vw);
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.85);
          isolation: isolate;
        }
        #settings-title {
          color: #fff;
          font-size: 1.5em;
          font-weight: bold;
          margin-bottom: 15px;
        }
        #manualSetTier {
          color: white;
          padding: 2px;
          text-align: center;
        }
        #manualSetTier:disabled {
          color: grey;
        }
        .section-heading {
          color: #00bc8c;
          font-size: 1.1em;
          margin-bottom: 10px;
          font-weight: bold;
        }
        .setting {
          margin-bottom: 10px;
          margin-left: 15px;
        }
        .setting-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .setting-row .settingsLabel {
          display: inline;
          margin-bottom: 0;
          flex: 1;
        }
        .awa-filter-mode {
          background: #111;
          color: #fff;
          border: 1px solid #555;
          border-radius: 4px;
          padding: 3px 6px;
          min-width: 5.2em;
        }
        .settingsLabel {
          color: #fff;
          display: block;
          margin-bottom: 5px;
        }
        #saveFilterSettings {
          background: #00bc8c;
          color: #fff;
          border: none;
          padding: 5px 15px;
          border-radius: 4px;
          cursor: pointer;
        }
        #closeFilterSettings {
          background: #e74c3c;
          color: #fff;
          border: none;
          padding: 5px 15px;
          border-radius: 4px;
          margin-left: 10px;
          cursor: pointer;
        }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          border: 0;
        }
      </style>
    `;
	}
	function buildFilterModeOptions(mode) {
		return [
			["off", "Show"],
			["dim", "Dim"],
			["hide", "Hide"]
		].map(([value, label]) => `<option value="${value}" ${mode === value ? "selected" : ""}>${label}</option>`).join("");
	}
	function buildFilterModeRow(id, label, description, mode) {
		return `
                <div class="setting setting-row">
                  <label class="settingsLabel" for="${id}">${label}</label>
                  <select id="${id}" class="awa-filter-mode" aria-describedby="${id}Desc">
                    ${buildFilterModeOptions(mode)}
                  </select>
                  <span id="${id}Desc" class="sr-only">${description}</span>
                </div>`;
	}
	function buildGlobalSettingsSection(settings) {
		const isHigherTierOff = settings.higherTier === "off";
		return `
            <div class="settings-section" style="margin-bottom: 20px">
              <div role="heading" aria-level="2" class="section-heading">
                Global Settings
              </div>
              <div
                class="settings-group"
                role="group"
                aria-label="Global Filter Options">
                ${buildFilterModeRow("higherTier", "Higher Tier Content", "Show, dim, or hide content that requires a higher tier than yours", settings.higherTier)}
                <div class="setting">
                  <label class="settingsLabel">
                    <input type="checkbox" id="autoSyncTier" ${isHigherTierOff ? "disabled" : ""} ${settings.autoSyncTier ? "checked" : ""}
                    aria-describedby="autoSyncTierDesc"> Auto Sync Tier
                  </label>
                  <span id="autoSyncTierDesc" class="sr-only"
                    >If checked, tier restrictions will be automatically synced from
                    your profile</span
                  >
                </div>
                <div class="setting">
                  <label class="settingsLabel">
                    User tier:
                    <input id="manualSetTier" type="text" inputmode="numeric" pattern="[0-9]*" size="1" maxlength="2" ${isHigherTierOff || settings.autoSyncTier ? "disabled" : ""} value="${settings.userTier || ""}"
                    aria-describedby="manualSetTierDesc">
                  </label>
                  <span id="manualSetTierDesc" class="sr-only">
                    The user tier that is used to filter content on the site</span>
                </div>
              </div>
            </div>`;
	}
	function buildMarketplaceSettingsSection(settings) {
		return `
            <div class="settings-section" style="margin-bottom: 20px">
              <div role="heading" aria-level="2" class="section-heading">
                Marketplace &amp; Game Vault
              </div>
              <div
                class="settings-group"
                role="group"
                aria-label="Marketplace Options">
                ${buildFilterModeRow("outOfStock", "Out of Stock Items", "Show, dim, or hide marketplace items that are out of stock", settings.outOfStock)}
                ${buildFilterModeRow("claimed", "Claimed Items", "Show, dim, or hide marketplace items you have already claimed", settings.claimed)}
              </div>
            </div>`;
	}
	function buildGiveawaysSettingsSection(settings) {
		return `
            <div class="settings-section" style="margin-bottom: 20px">
              <div role="heading" aria-level="2" class="section-heading">
                Community Giveaways
              </div>
              <div
                class="settings-group"
                role="group"
                aria-label="Community Giveaway Options">
                ${buildFilterModeRow("closedGiveaways", "Closed Giveaways", "Show, dim, or hide giveaways that have ended", settings.closedGiveaways)}
                ${buildFilterModeRow("enteredGiveaways", "Entered Giveaways", "Show, dim, or hide giveaways you have already entered", settings.enteredGiveaways)}
              </div>
            </div>`;
	}
	function buildSettingsMenuHTML(settings) {
		return `
      <div id="alienware-filter-settings-backdrop" style="display: none" hidden></div>
      <div
        id="alienware-filter-settings"
        role="dialog"
        aria-labelledby="settings-title"
        aria-modal="true"
        hidden
        style="display: none">
        <div role="document">
          <div id="settings-title" role="heading" aria-level="1">Filter Settings</div>
          <form>
            ${buildGlobalSettingsSection(settings)}
            ${buildMarketplaceSettingsSection(settings)}
            ${buildGiveawaysSettingsSection(settings)}
            <div style="text-align: right">
              <button id="saveFilterSettings" type="submit">Save</button>
              <button id="closeFilterSettings" type="button">Close</button>
            </div>
          </form>
        </div>
      </div>
      ${buildSettingsMenuStyles()}
    `;
	}
	function isCheckboxChecked(id) {
		return document.querySelector(`#${id}`)?.checked ?? false;
	}
	function getFilterSettingsModal() {
		return document.querySelector("#alienware-filter-settings") ?? void 0;
	}
	function getFilterSettingsBackdrop() {
		return document.querySelector("#alienware-filter-settings-backdrop") ?? void 0;
	}
	function setFilterSettingsOpen(isOpen) {
		const modal = getFilterSettingsModal();
		if (!modal) return;
		const backdrop = getFilterSettingsBackdrop();
		modal.style.display = isOpen ? "block" : "none";
		modal.hidden = !isOpen;
		if (backdrop) {
			backdrop.style.display = isOpen ? "block" : "none";
			backdrop.hidden = !isOpen;
		}
	}
	function readFilterModeFromForm(id, fallback) {
		const value = document.querySelector(`#${id}`)?.value;
		return isFilterMode(value) ? value : fallback;
	}
	function readSettingsFromForm() {
		const isAutoSyncTier = isCheckboxChecked("autoSyncTier");
		const higherTier = readFilterModeFromForm("higherTier", defaultSettings.higherTier);
		return {
			higherTier,
			autoSyncTier: isAutoSyncTier,
			outOfStock: readFilterModeFromForm("outOfStock", defaultSettings.outOfStock),
			claimed: readFilterModeFromForm("claimed", defaultSettings.claimed),
			closedGiveaways: readFilterModeFromForm("closedGiveaways", defaultSettings.closedGiveaways),
			enteredGiveaways: readFilterModeFromForm("enteredGiveaways", defaultSettings.enteredGiveaways),
			...!isAutoSyncTier && higherTier !== "off" && { userTier: Number(document.querySelector("#manualSetTier")?.value) }
		};
	}
	function bindSettingsMenuFocusTrap(modal) {
		modal.addEventListener("keydown", (event) => {
			if (event.key !== "Tab") return;
			const focusableElements = [...modal.querySelectorAll("button, input, select")];
			const firstFocusable = focusableElements[0];
			const lastFocusable = focusableElements.at(-1);
			if (firstFocusable === void 0 || lastFocusable === void 0) return;
			if (event.shiftKey) {
				if (document.activeElement === firstFocusable) {
					lastFocusable.focus();
					event.preventDefault();
				}
			} else if (document.activeElement === lastFocusable) {
				firstFocusable.focus();
				event.preventDefault();
			}
		});
	}
	function syncTierInputState() {
		const higherTier = readFilterModeFromForm("higherTier", defaultSettings.higherTier);
		const autoSync = document.querySelector("#autoSyncTier");
		const manualTier = document.querySelector("#manualSetTier");
		const isHigherTierOff = higherTier === "off";
		if (autoSync) autoSync.disabled = isHigherTierOff;
		if (manualTier) manualTier.disabled = isHigherTierOff || (autoSync?.checked ?? true);
	}
	function bindSettingsMenuEvents(modal) {
		document.querySelector("#higherTier")?.addEventListener("change", () => {
			syncTierInputState();
		});
		document.querySelector("#autoSyncTier")?.addEventListener("change", () => {
			syncTierInputState();
		});
		document.querySelector("#saveFilterSettings")?.addEventListener("click", (event) => {
			event.preventDefault();
			saveSettings(readSettingsFromForm());
			setFilterSettingsOpen(false);
			location.reload();
		});
		document.querySelector("#closeFilterSettings")?.addEventListener("click", () => {
			setFilterSettingsOpen(false);
		});
		getFilterSettingsBackdrop()?.addEventListener("click", () => {
			setFilterSettingsOpen(false);
		});
		document.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && modal.style.display === "block") setFilterSettingsOpen(false);
		});
		bindSettingsMenuFocusTrap(modal);
	}
	async function createSettingsMenu() {
		if (document.querySelector("#alienware-filter-settings")) {
			setFilterSettingsOpen(false);
			return;
		}
		const settings = await getSettings();
		document.body.insertAdjacentHTML("beforeend", buildSettingsMenuHTML(settings));
		const modal = getFilterSettingsModal();
		if (!modal) return;
		setFilterSettingsOpen(false);
		bindSettingsMenuEvents(modal);
	}
	function addSettingsButton() {
		const menuList = document.querySelector(".nav-item-mus .dropdown-menu.dropdown-menu-end");
		if (!menuList || menuList.querySelector("[data-filter-settings-menu]")) return;
		const settingsItem = document.createElement("a");
		settingsItem.className = "dropdown-item";
		settingsItem.href = "#";
		settingsItem.dataset.filterSettingsMenu = "1";
		settingsItem.textContent = "Filter Settings";
		settingsItem.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setFilterSettingsOpen(true);
		});
		menuList.insertBefore(settingsItem, menuList.lastElementChild);
	}
	function watchSettingsButton() {
		addSettingsButton();
		if (document.documentElement.dataset.awaFilterMenuWatch === "1") return;
		document.documentElement.dataset.awaFilterMenuWatch = "1";
		new MutationObserver(() => {
			if (!document.querySelector("[data-filter-settings-menu]")) addSettingsButton();
		}).observe(document.documentElement, {
			childList: true,
			subtree: true
		});
	}
	async function initFilters() {
		ensureFilterStyles();
		await createSettingsMenu();
		watchSettingsButton();
		if ((await getSettings()).autoSyncTier) await checkAndStoreTier();
		watchPageFilters();
	}
	var READING_KEY = "ucfReadingMode";
	var TABLES_KEY = "ucfClassicTables";
	var STYLE_ID = "awa-ucf-reading-mode-styles";
	var BAR_ID = "awa-ucf-reading-bar";
	var JUMP_ID = "awa-ucf-jump";
	var ACTION_ID = "awa-ucf-reading-action";
	var READING_CLASS = "awa-ucf-reading-mode";
	var TABLES_CLASS = "awa-ucf-classic-tables";
	var RULE_ROW_CLASS = "awa-ucf-table-rule";
	var UCF_POST_PATH = /\/ucf\/show\//i;
	var NAVBAR_OFFSET_PX = 80;
	var NAVBAR_OFFSET = `${NAVBAR_OFFSET_PX}px`;
	var STICKY_GAP_PX = 8;
	var TABLE_SCOPE = ":is(.ucf__content, .discussion__op-content, .js-comments-post)";
	var DATA_TABLE = "table:has(:is(th + th, td + td))";
	var HEADER_PAD = /[\u{00A0}\u{2007}\u{202F}\u{3000}]+/gu;
	function isUcfPostPage() {
		return UCF_POST_PATH.test(location.pathname);
	}
	function isFlag(value) {
		return typeof value === "boolean";
	}
	async function isStoredFlag(key, isDefault) {
		const raw = await _GM.getValue(key);
		if (raw === void 0 || raw === null) return isDefault;
		if (isFlag(raw)) return raw;
		if (raw === "true" || raw === "1") return true;
		if (raw === "false" || raw === "0") return false;
		if (typeof raw === "string") try {
			return JSON.parse(raw) === true;
		} catch {
			return isDefault;
		}
		return isDefault;
	}
	async function loadLayoutState() {
		const [isReading, isClassicTables] = await Promise.all([isStoredFlag(READING_KEY, false), isStoredFlag(TABLES_KEY, true)]);
		return {
			isReading,
			isClassicTables
		};
	}
	function layoutStateFromDom() {
		return {
			isReading: document.documentElement.classList.contains(READING_CLASS),
			isClassicTables: document.documentElement.classList.contains(TABLES_CLASS)
		};
	}
	function buildReadingModeCss() {
		return `
    .forums__header:has(#${BAR_ID}) {
      min-height: 0 !important;
      height: auto !important;
      position: sticky;
      top: ${NAVBAR_OFFSET};
      z-index: 1020;
      background: #f7f8f8;
      border-bottom: 1px solid rgba(0, 0, 0, 0.08);
      padding: 0.45rem 0.25rem;
    }

    #${BAR_ID} {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 0.85rem 1.5rem;
      flex-wrap: wrap;
      width: 100%;
    }

    #${JUMP_ID} {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }

    .awa-ucf-jump__btn {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      margin: 0;
      padding: 0.28rem 0.65rem;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 999px;
      background: #fff;
      color: #282829;
      font-weight: 600;
      font-size: 0.82rem;
      line-height: 1.2;
      cursor: pointer;
    }

    .awa-ucf-jump__btn:hover,
    .awa-ucf-jump__btn:focus-visible {
      border-color: #00bc8c;
      color: #0a7a5c;
      outline: none;
    }

    .awa-ucf-jump__btn:focus-visible {
      outline: 2px solid #00bc8c;
      outline-offset: 2px;
    }

    .awa-ucf-reading-toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.7rem;
      margin: 0;
      cursor: pointer;
      user-select: none;
      color: #282829;
      font-weight: 600;
      font-size: 0.95rem;
      line-height: 1.2;
    }

    .awa-ucf-reading-toggle__input {
      position: absolute;
      inset: 0;
      opacity: 0;
      margin: 0;
      width: 100%;
      height: 100%;
      cursor: pointer;
    }

    .awa-ucf-reading-toggle__switch {
      position: relative;
      flex: 0 0 auto;
      width: 2.6rem;
      height: 1.45rem;
      border-radius: 999px;
      background: #c5c8cc;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
      transition: background-color 0.15s ease;
    }

    .awa-ucf-reading-toggle__switch::after {
      content: '';
      position: absolute;
      top: 0.15rem;
      left: 0.15rem;
      width: 1.15rem;
      height: 1.15rem;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
      transition: transform 0.15s ease;
    }

    .awa-ucf-reading-toggle:has(.awa-ucf-reading-toggle__input:focus-visible) .awa-ucf-reading-toggle__switch {
      outline: 2px solid #00bc8c;
      outline-offset: 2px;
    }

    .awa-ucf-reading-toggle:has(.awa-ucf-reading-toggle__input:checked) .awa-ucf-reading-toggle__switch {
      background: #00bc8c;
    }

    .awa-ucf-reading-toggle:has(.awa-ucf-reading-toggle__input:checked) .awa-ucf-reading-toggle__switch::after {
      transform: translateX(1.15rem);
    }

    .awa-ucf-reading-toggle__text {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }

    html.${READING_CLASS} .forums__header:has(#${BAR_ID}),
    html.${TABLES_CLASS} .forums__header:has(#${BAR_ID}) {
      background: #e8f7f2;
      border-bottom-color: #00bc8c;
    }

    html.${READING_CLASS} .row.forums-layout > .col-12.col-lg-4 {
      display: none !important;
    }

    html.${READING_CLASS} .row.forums-layout > .col-12.col-lg-8 {
      flex: 0 0 100% !important;
      max-width: 100% !important;
      width: 100% !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row {
      flex-wrap: wrap;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 {
      flex: 0 0 100% !important;
      max-width: 100% !important;
      width: 100% !important;
      padding-top: 0.2rem;
      padding-bottom: 0;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-9.col-md-9 {
      flex: 0 0 100% !important;
      max-width: 100% !important;
      width: 100% !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-avatar-container {
      max-height: none !important;
      display: flex !important;
      flex-direction: row !important;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem 0.7rem;
      width: auto !important;
      max-width: 100%;
      padding: 0.1rem 0 !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-avatar-container > .row {
      margin: 0 !important;
      width: auto !important;
      flex: 0 0 auto;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-avatar-container > .row:has(.profile-subtitle.images) {
      order: -1;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 :is(.profile-username, .profile-subtitle) {
      text-align: left !important;
      padding: 0 !important;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-full-avatar {
      width: 2.5rem !important;
      height: 2.5rem !important;
      overflow: hidden;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-full-avatar :is(.user-avatar__layer, .user-avatar__sizer) {
      width: 100% !important;
      height: 100% !important;
      max-width: none !important;
      object-fit: cover;
    }

    html.${READING_CLASS} :is(article.discussion__op, .js-comments-post) > .row > .col-lg-3.col-md-3 .user-full-avatar .user-avatar__sizer {
      position: absolute !important;
      inset: 0;
    }

    html.${READING_CLASS} .ucf__content img[src*="user_badge"] {
      display: none;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} figure:has(${DATA_TABLE}) {
      overflow-x: auto;
      max-width: 100%;
      margin: 0.85rem 0;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} {
      width: 100% !important;
      min-width: 36rem;
      border-collapse: collapse !important;
      background: #fff !important;
      color: #3a3a3a !important;
      border: 1px solid #5b9bd5 !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} :is(th, td) {
      border: 1px solid #5b9bd5 !important;
      padding: 0.5rem 0.7rem !important;
      vertical-align: top !important;
      color: #3a3a3a !important;
      background: #fff !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} th {
      color: #2e75b6 !important;
      text-align: center !important;
      font-weight: 700 !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} ${DATA_TABLE} th strong {
      color: inherit !important;
      font-weight: 700 !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} tr.${RULE_ROW_CLASS} {
      display: none !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} table:not(:has(:is(th + th, td + td))) {
      border: none !important;
      width: auto !important;
      min-width: 0 !important;
      background: transparent !important;
    }

    html.${TABLES_CLASS} ${TABLE_SCOPE} table:not(:has(:is(th + th, td + td))) :is(th, td) {
      border: none !important;
      padding: 0.2rem 0 !important;
      background: transparent !important;
      color: inherit !important;
      text-align: inherit !important;
    }

    @media (prefers-reduced-motion: reduce) {
      .awa-ucf-reading-toggle__switch,
      .awa-ucf-reading-toggle__switch::after {
        transition: none;
      }
    }
  `;
	}
	function ensureStyles() {
		let style = document.querySelector(`#${STYLE_ID}`);
		if (!style) {
			style = document.createElement("style");
			style.id = STYLE_ID;
			(document.head || document.documentElement).append(style);
		}
		style.textContent = buildReadingModeCss();
	}
	function applyLayout(state) {
		document.documentElement.classList.toggle(READING_CLASS, state.isReading);
		document.documentElement.classList.toggle(TABLES_CLASS, state.isClassicTables);
	}
	function expandIconClass(isEnabled, extraClass) {
		const name = isEnabled ? "fa-compress" : "fa-expand";
		return extraClass ? `fa ${name} ${extraClass}` : `fa ${name}`;
	}
	function syncToggleUi(state) {
		const readingInput = document.querySelector(`#${BAR_ID} [data-awa-ucf-toggle="reading"]`);
		if (readingInput) readingInput.checked = state.isReading;
		const tablesInput = document.querySelector(`#${BAR_ID} [data-awa-ucf-toggle="tables"]`);
		if (tablesInput) tablesInput.checked = state.isClassicTables;
		const readingIcon = document.querySelector(`#${BAR_ID} [data-awa-ucf-icon="reading"]`);
		if (readingIcon) readingIcon.className = expandIconClass(state.isReading, "awa-ucf-reading-toggle__icon");
		const action = document.querySelector(`#${ACTION_ID}`);
		if (action) {
			action.setAttribute("aria-pressed", state.isReading ? "true" : "false");
			const actionIcon = action.querySelector("i");
			if (actionIcon) actionIcon.className = expandIconClass(state.isReading);
			const actionLabel = action.querySelector(".awa-ucf-reading-action-label");
			if (actionLabel) actionLabel.textContent = state.isReading ? "Exit reading mode" : "Reading mode";
		}
	}
	async function persistLayout(state) {
		await Promise.all([_GM.setValue(READING_KEY, state.isReading), _GM.setValue(TABLES_KEY, state.isClassicTables)]);
	}
	async function setLayout(patch) {
		const next = {
			...layoutStateFromDom(),
			...patch
		};
		applyLayout(next);
		syncToggleUi(next);
		if (next.isClassicTables) prepareTables();
		await persistLayout(next);
	}
	function normalizeHeaderText(cell) {
		const walk = (node) => {
			if (node.nodeType === Node.TEXT_NODE && node.textContent) {
				node.textContent = node.textContent.replaceAll(HEADER_PAD, " ").replaceAll(/\s+/g, " ").trim();
				return;
			}
			if (node.nodeType === Node.ELEMENT_NODE) for (const child of node.childNodes) walk(child);
		};
		walk(cell);
	}
	function isRuleRow(row) {
		const text = (row.textContent ?? "").replaceAll(/\s+/g, "");
		return text.length > 0 && !/\p{L}|\p{N}/u.test(text);
	}
	function prepareTables() {
		const rows = document.querySelectorAll(`${TABLE_SCOPE} tr`);
		for (const row of rows) row.classList.toggle(RULE_ROW_CLASS, isRuleRow(row));
		const headers = document.querySelectorAll(`${TABLE_SCOPE} th`);
		for (const header of headers) {
			if (header.dataset.awaUcfHeader === "1") continue;
			normalizeHeaderText(header);
			header.dataset.awaUcfHeader = "1";
		}
	}
	function createIcon(className) {
		const icon = document.createElement("i");
		icon.className = className;
		icon.setAttribute("aria-hidden", "true");
		return icon;
	}
	function buildSwitch(options) {
		const label = document.createElement("label");
		label.className = "awa-ucf-reading-toggle";
		label.title = options.title;
		const input = document.createElement("input");
		input.type = "checkbox";
		input.setAttribute("role", "switch");
		input.checked = options.isOn;
		input.className = "awa-ucf-reading-toggle__input";
		input.dataset.awaUcfToggle = options.toggle;
		input.setAttribute("aria-label", options.label);
		input.title = options.title;
		const switchUi = document.createElement("span");
		switchUi.className = "awa-ucf-reading-toggle__switch";
		switchUi.setAttribute("aria-hidden", "true");
		const text = document.createElement("span");
		text.className = "awa-ucf-reading-toggle__text";
		const icon = createIcon(options.iconClass);
		if (options.toggle === "reading") icon.dataset.awaUcfIcon = "reading";
		text.append(icon, document.createTextNode(options.label));
		label.append(input, text, switchUi);
		input.addEventListener("change", () => {
			if (options.toggle === "reading") {
				setLayout({ isReading: input.checked });
				return;
			}
			setLayout({ isClassicTables: input.checked });
		});
		return label;
	}
	function shouldReduceMotion() {
		return matchMedia("(prefers-reduced-motion: reduce)").matches;
	}
	function stickyOffsetPx() {
		return NAVBAR_OFFSET_PX + (document.querySelector(".forums__header")?.getBoundingClientRect().height ?? 0) + STICKY_GAP_PX;
	}
	function postTopElement() {
		return document.querySelector("article.discussion__op") ?? document.querySelector("[id^=\"post-content-\"]") ?? void 0;
	}
	function postBottomElement() {
		return document.querySelector(".discussion__op-actions") ?? document.querySelector("[id^=\"post-content-\"]") ?? void 0;
	}
	function scrollToPostEdge(edge) {
		const behavior = shouldReduceMotion() ? "auto" : "smooth";
		const target = edge === "top" ? postTopElement() : postBottomElement();
		if (!target) {
			scrollTo({
				top: edge === "top" ? 0 : document.documentElement.scrollHeight,
				behavior
			});
			return;
		}
		const top = scrollY + target.getBoundingClientRect().top - stickyOffsetPx();
		scrollTo({
			top: Math.max(0, top),
			behavior
		});
	}
	function buildJumpButton(edge, label, iconClass) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "awa-ucf-jump__btn";
		const description = edge === "top" ? "Jump to the top of this post" : "Jump to the bottom of this post";
		button.title = description;
		button.setAttribute("aria-label", description);
		button.append(createIcon(iconClass), document.createTextNode(` ${label}`));
		button.addEventListener("click", () => {
			scrollToPostEdge(edge);
		});
		return button;
	}
	function buildJumpControls() {
		const group = document.createElement("div");
		group.id = JUMP_ID;
		group.append(buildJumpButton("top", "Top", "fa fa-chevron-up"), buildJumpButton("bottom", "Bottom", "fa fa-chevron-down"));
		return group;
	}
	function buildReadingBar(state) {
		const bar = document.createElement("div");
		bar.id = BAR_ID;
		bar.append(buildSwitch({
			toggle: "reading",
			label: "Reading mode",
			title: "Hide the board list and compact author columns so the post uses the full width",
			isOn: state.isReading,
			iconClass: expandIconClass(state.isReading, "awa-ucf-reading-toggle__icon")
		}), buildSwitch({
			toggle: "tables",
			label: "Classic tables",
			title: "Restore table borders and header styling. The published forum view strips them",
			isOn: state.isClassicTables,
			iconClass: "fa fa-table awa-ucf-reading-toggle__icon"
		}), buildJumpControls());
		return bar;
	}
	function buildActionButton(state) {
		const button = document.createElement("button");
		button.type = "button";
		button.id = ACTION_ID;
		button.className = "btn btn-default";
		button.setAttribute("aria-pressed", state.isReading ? "true" : "false");
		button.title = "Reading mode";
		const icon = createIcon(expandIconClass(state.isReading));
		const label = document.createElement("span");
		label.className = "hidden-xs awa-ucf-reading-action-label";
		label.textContent = state.isReading ? "Exit reading mode" : "Reading mode";
		button.append(icon, document.createTextNode(" "), label);
		button.addEventListener("click", () => {
			setLayout({ isReading: !layoutStateFromDom().isReading });
		});
		return button;
	}
	function mountReadingBar(state) {
		if (document.querySelector(`#${BAR_ID}`)) {
			syncToggleUi(state);
			return;
		}
		const bar = buildReadingBar(state);
		const header = document.querySelector(".forums__header");
		if (header) {
			header.prepend(bar);
			return;
		}
		const title = document.querySelector(".discussion__op-title");
		if (title) {
			title.prepend(bar);
			return;
		}
		document.querySelector("article.discussion__op")?.prepend(bar);
	}
	function mountActionButton(state) {
		if (document.querySelector(`#${ACTION_ID}`)) {
			syncToggleUi(state);
			return;
		}
		const group = document.querySelector(".discussion__op-actions .btn-group");
		if (!group) return;
		group.append(buildActionButton(state));
	}
	function observeForRerender() {
		const root = document.querySelector("#main") ?? document.body;
		new MutationObserver(() => {
			const state = layoutStateFromDom();
			if (!document.querySelector(`#${BAR_ID}`) || !document.querySelector(`#${ACTION_ID}`)) {
				mountReadingBar(state);
				mountActionButton(state);
			}
			if (state.isClassicTables) prepareTables();
		}).observe(root, {
			childList: true,
			subtree: true
		});
	}
	async function initUcfReadingMode() {
		if (!isUcfPostPage()) return;
		ensureStyles();
		const state = await loadLayoutState();
		applyLayout(state);
		if (state.isClassicTables) prepareTables();
		mountReadingBar(state);
		mountActionButton(state);
		observeForRerender();
	}
	function waitForBody() {
		if (document.body) return Promise.resolve(document.body);
		return new Promise((resolve) => {
			const observer = new MutationObserver(() => {
				if (!document.body) return;
				observer.disconnect();
				resolve(document.body);
			});
			observer.observe(document.documentElement, { childList: true });
		});
	}
	initArtifactOptimizer();
	await(waitForBody());
	await(initFilters());
	await(initUcfReadingMode());
})();
