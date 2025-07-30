async function fetchAndDeobfuscate(videoId) {
	const headers = {
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		'Accept-Language': 'en-US,en;q=0.9',
		Referer: '__',
	};

	try {
		const response = await fetch(`https://mp3api.ytjar.info/?id=${videoId}`, { headers });
		if (!response.ok) throw new Error(`Failed to fetch page: ${response.statusText}`);

		const pageText = await response.text();
		const scriptMatches = pageText.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
		if (!scriptMatches) throw new Error('No script tags found.');

		let encodedStr = null,
			key = null,
			num1 = null,
			num2 = null,
			num3 = null,
			num4 = null;
		for (const script of scriptMatches) {
			const paramMatch = script.match(/\(\s*"(.*?)"\s*,\s*(\d+)\s*,\s*"(.*?)"\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
			if (paramMatch) {
				[, encodedStr, num1, key, num2, num3, num4] = paramMatch;
				break;
			}
		}
		if (!encodedStr || !key) throw new Error('No encoded parameters found in any script tag.');

		function decodeBase(d, e, f) {
			const charset = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/';
			const baseE = charset.slice(0, e);
			const baseF = charset.slice(0, f);
			let value = d
				.split('')
				.reverse()
				.reduce((acc, char, index) => {
					const pos = baseE.indexOf(char);
					return pos !== -1 ? acc + pos * Math.pow(e, index) : acc;
				}, 0);
			let result = '';
			while (value > 0) {
				result = baseF[value % f] + result;
				value = Math.floor(value / f);
			}
			return result || '0';
		}

		function deobfuscate(h, _, n, t, e) {
			let result = '';
			for (let i = 0; i < h.length; i++) {
				let s = '';
				while (h[i] !== n[e]) {
					s += h[i];
					i++;
				}
				for (let j = 0; j < n.length; j++) s = s.replace(new RegExp(n[j], 'g'), j);
				result += String.fromCharCode(decodeBase(s, e, 10) - t);
			}
			return result;
		}

		const deobfuscatedText = deobfuscate(encodedStr, '', key, num2, num3);
		const tSMatch = deobfuscatedText.match(/var\s+tS\s*=\s*"(\d+)"/);
		const tHMatch = deobfuscatedText.match(/var\s+tH\s*=\s*"([a-f0-9]+)"/);

		return { tS: tSMatch?.[1] || null, tH: tHMatch?.[1] || null };
	} catch (error) {
		console.error('Error:', error);
		return null;
	}
}

export default {
	fetch: handleRequest,
};

const handlers = {
	'/sitemap.xml': handleSitemap,
	'/stream': streamMp3Url,
	'/search': searchTracks,
	'/track': getTrackInfo,
	'/next': getNextTrack,
	'/lyrics': getTrackLyrics,
	'/suggestions': getSuggestions,
};

async function handleRequest(request, env, ctx) {
	const url = new URL(request.url);
	const handler = handlers[url.pathname];
	if (!handler) return jsonResponse({ error: 'Not Found' }, 404);
	return handler(request, env, ctx);
}

const STATIC_SITEMAP_KEY = 'static_sitemap';
const STATIC_SITEMAP_TIMESTAMP_KEY = 'static_sitemap_timestamp';
const SITEMAP_EXPIRY_DAYS = 2;
const STATIC_THRESHOLD = 25;

/**
 * Converts a slug and videoId into a <url> entry.
 */
function generateUrlEntry(slug, date) {
	return `
    <url>
      <loc>https://flexiyo.web.app/music/${slug}</loc>
      <lastmod>${date}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.8</priority>
    </url>
  `.trim();
}

/**
 * Converts KV (slug → videoId) into full sitemap XML.
 */
async function buildDynamicSitemap(kvStore) {
	const keys = await kvStore.list();
	const entries = [];

	for (const key of keys.keys) {
		const rawData = await kvStore.get(key.name);
		if (!rawData) continue;

		let data;
		try {
			data = JSON.parse(rawData);
		} catch (e) {
			console.error('Invalid JSON in KV:', key.name);
			continue;
		}

		if (data && data.slug) {
			entries.push(generateUrlEntry(data.slug, data.playedAt));
		}
	}

	return wrapInSitemap(entries);
}

/**
 * Wraps <urlset> around entries.
 */
function wrapInSitemap(entries) {
	return `<?xml version="1.0" encoding="UTF-8"?>
  <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('\n')}</urlset>`;
}

/**
 * Handles the /sitemap.xml request.
 */
async function handleSitemap(_, env) {
	const kvStore = env.YTMUSIC_SITEMAP_KV;
	const staticSitemap = await kvStore.get(STATIC_SITEMAP_KEY);
	const staticTimestamp = await kvStore.get(STATIC_SITEMAP_TIMESTAMP_KEY);

	if (staticSitemap && staticTimestamp) {
		const createdAt = new Date(staticTimestamp);
		const ageInMs = Date.now() - createdAt.getTime();
		const twoDaysInMs = SITEMAP_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

		if (ageInMs < twoDaysInMs) {
			return new Response(staticSitemap, {
				headers: { 'Content-Type': 'application/xml' },
			});
		} else {
			await kvStore.delete(STATIC_SITEMAP_KEY);
			await kvStore.delete(STATIC_SITEMAP_TIMESTAMP_KEY);
		}
	}

	const keys = await kvStore.list();
	const keyCount = keys.keys.length;

	const sitemap = await buildDynamicSitemap(kvStore);

	if (keyCount >= STATIC_THRESHOLD) {
		await kvStore.put(STATIC_SITEMAP_KEY, sitemap);
		await kvStore.put(STATIC_SITEMAP_TIMESTAMP_KEY, new Date().toISOString());
	}

	return new Response(sitemap, {
		headers: { 'Content-Type': 'application/xml' },
	});
}

async function streamMp3Url(request) {
	const url = new URL(request.url);
	const target = url.searchParams.get('url');

	if (!target) {
		return jsonResponse({ error: 'Missing url param' }, 400);
	}

	const res = await fetch(target, { headers: request.headers });

	return new Response(res.body, {
		status: res.status,
		headers: {
			'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
			'Content-Disposition': 'attachment; filename="file.mp3"',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

async function searchTracksInternal(term, continuation = null) {
	const body = continuation ? { continuation } : { query: term, params: 'EgWKAQIIAWoSEAMQBBAJEA4QChAFEBEQEBAV' };
	const ytMusicData = await fetchYTMusic('search', body);
	if (!ytMusicData) throw new Error('YouTube Music API failed');

	const musicShelf =
		ytMusicData?.continuationContents?.musicShelfContinuation ??
		ytMusicData?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents?.find(
			(c) => c?.musicShelfRenderer
		)?.musicShelfRenderer;

	const results = (musicShelf?.contents || [])
		.map(({ musicResponsiveListItemRenderer: track }) => {
			if (!track?.playlistItemData?.videoId) return null;
			const title = track.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
			const artistsRaw = track.flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
			const artists = artistsRaw.map((r) => r?.text).join('');
			const playsCount = track.flexColumns?.[2]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || null;
			const images = (track.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || []).flatMap((img) =>
				img?.url?.includes('w60-h60')
					? [
							img,
							{ ...img, url: img.url.replace('w60-h60', 'w120-h120'), width: 120, height: 120 },
							{ ...img, url: img.url.replace('w60-h60', 'w400-h400'), width: 400, height: 400 },
							{ ...img, url: img.url.replace('w60-h60', 'w600-h600'), width: 600, height: 600 },
					  ]
					: []
			);

			return { videoId: track.playlistItemData.videoId, title, artists, playsCount, images };
		})
		.filter(Boolean);

	const next = musicShelf?.continuations?.[0]?.nextContinuationData?.continuation || null;
	return { results, continuation: next };
}

async function searchTracks(request) {
	const { searchParams } = new URL(request.url);
	const term = searchParams.get('term');
	const continuation = searchParams.get('continuation');
	if (!term && !continuation) return jsonResponse({ error: 'Missing search term' }, 400);

	try {
		const { results, continuation: next } = await searchTracksInternal(term, continuation);
		return jsonResponse({ success: true, data: { results, continuation: next } });
	} catch (error) {
		return jsonResponse({ error: error.message }, 500);
	}
}

async function getTrackInfo(request, env) {
	const { searchParams } = new URL(request.url);
	const videoId = searchParams.get('videoId');

	if (!videoId) return jsonResponse({ error: 'Missing video ID' }, 400);

	try {
		const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
			},
		});

		const html = await response.text();
		const regex = html.match(/var ytInitialPlayerResponse = (.*?);\s*<\/script>/);

		if (!regex) {
			console.error('Could not extract ytInitialPlayerResponse');
			throw new Error('Unable to find video data');
		}

		const result = JSON.parse(regex[1]);

		const { title, lengthSeconds, keywords, shortDescription, thumbnail, viewCount } = result.videoDetails;

		const artists = shortDescription.split('\n').filter((line) => line.trim() !== '')[1];
		const duration = ((s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`)(Number(lengthSeconds));
		const images = thumbnail.thumbnails;
		const playsCount = ((n) =>
			n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n)(
			Number(viewCount)
		);

		const { tS, tH } = await fetchAndDeobfuscate(videoId);
		if (!tS || !tH) throw new Error('Failed to fetch deobfuscated result');
		const { playlistId, browseId } = await getRelativeTrackInfo(videoId);

		const playedAt = new Date().toISOString();

		const baseSlug = title
			.toLowerCase()
			.replace(/[^a-z0-9 ]+/g, '')
			.replace(/\s+/g, '-')
			.slice(0, 10);

		const slug = `${baseSlug}_${videoId}`;

		await env.YTMUSIC_SITEMAP_KV.put(`${videoId}`, JSON.stringify({ slug, playedAt }));

		return jsonResponse({
			success: true,
			data: {
				videoId,
				slug,
				title,
				artists,
				duration,
				playsCount,
				images,
				keywords,
				playlistId,
				browseId,
				tS,
				tH,
			},
		});
	} catch (error) {
		console.error(Object(error));
		return jsonResponse({ error: error.message }, 500);
	}
}

async function getRelativeTrackInfo(videoId) {
	try {
		const ytMusicData = await fetchYTMusic('next', { videoId });
		if (!ytMusicData?.contents || !ytMusicData?.currentVideoEndpoint) throw new Error('No video details available');

		const playlistId =
			ytMusicData?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.find(
				(tab) => tab?.tabRenderer?.title === 'Up next'
			)?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents?.[1]?.automixPreviewVideoRenderer?.content
				?.automixPlaylistVideoRenderer?.navigationEndpoint?.watchPlaylistEndpoint?.playlistId;

		const browseId =
			ytMusicData?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.find(
				(tab) => tab?.tabRenderer?.title === 'Lyrics'
			)?.tabRenderer?.endpoint?.browseEndpoint?.browseId;

		return { playlistId, browseId };
	} catch {
		return null;
	}
}

async function getNextTrack(request) {
	const { searchParams } = new URL(request.url);
	const videoId = searchParams.get('videoId');
	const playlistId = searchParams.get('playlistId');
	const playedTrackIds = searchParams.get('playedTrackIds');
	if (!videoId || !playlistId) return jsonResponse({ error: 'Missing video ID or playlist ID' }, 400);

	try {
		const ytMusicData = await fetchYTMusic('next', { videoId, playlistId, playedTrackIds });
		const playlist =
			ytMusicData?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]
				?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents;
		if (!playlist) throw new Error('No playlist available');

		const tracks = playlist
			.filter((item) => item?.playlistPanelVideoRenderer)
			.filter((item) => !playedTrackIds?.split(',').includes(item?.playlistPanelVideoRenderer?.videoId));
		const nextTrackId =
			tracks[Math.floor(Math.random() * tracks.length)]?.playlistPanelVideoRenderer?.navigationEndpoint?.watchEndpoint?.videoId;

		return jsonResponse({ success: true, data: { videoId: nextTrackId } });
	} catch (error) {
		return jsonResponse({ error: error.message }, 500);
	}
}

async function getTrackLyrics(request) {
	const { searchParams } = new URL(request.url);
	const browseId = searchParams.get('browseId');
	if (!browseId) return jsonResponse({ error: 'Missing browse ID' }, 400);

	try {
		const ytMusicData = await fetchYTMusic('browse', { browseId });
		const lyrics = ytMusicData?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer?.description?.runs?.[0]?.text;
		return jsonResponse({ success: true, data: lyrics || "Couldn't load the lyrics for this song." });
	} catch (error) {
		return jsonResponse({ error: error.message }, 500);
	}
}

async function getSuggestions(request) {
	const { searchParams } = new URL(request.url);
	const term = searchParams.get('term');
	if (!term) return jsonResponse({ error: 'Missing search term' }, 400);

	try {
		const ytMusicData = await fetchYTMusic('music/get_search_suggestions', { input: term });
		const suggestions = ytMusicData?.contents?.[0]?.searchSuggestionsSectionRenderer?.contents
			?.map((content) => ({
				suggestionText: content?.searchSuggestionRenderer?.suggestion?.runs?.[0]?.text,
				suggestionQuery: content?.searchSuggestionRenderer?.navigationEndpoint?.searchEndpoint?.query,
			}))
			.filter(Boolean);

		return jsonResponse({ success: true, data: { results: suggestions } });
	} catch (error) {
		return jsonResponse({ error: error.message }, 500);
	}
}

async function fetchYTMusic(endpoint, body) {
	const response = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ ...body, context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250317.01.00' } } }),
	});
	if (!response.ok) throw new Error(`YT Music API Error: ${response.status}`);
	return response.json();
}

function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}
