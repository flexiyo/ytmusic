import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Common headers
const headers = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	Referer: '__',
};

// Utility: JSON response
function jsonResponse(res, data, status = 200) {
	res.status(status).json(data);
}

// Function: Deobfuscate
async function fetchAndDeobfuscate(videoId) {
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
		if (!encodedStr || !key) throw new Error('No encoded parameters found.');

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

// Fetch YT Music
async function fetchYTMusic(endpoint, body) {
	const response = await fetch(`https://music.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			...body,
			context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20250317.01.00' } },
		}),
	});
	if (!response.ok) throw new Error(`YT Music API Error: ${response.status}`);
	return response.json();
}

// Internal Track Search
async function searchTracksInternal(term, continuation = null) {
	const body = continuation ? { continuation } : { query: term, params: 'EgWKAQIIAWoSEAMQBBAJEA4QChAFEBEQEBAV' };
	const ytMusicData = await fetchYTMusic('search', body);

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

// Relative Info
async function getRelativeTrackInfo(videoId) {
	try {
		const ytMusicData = await fetchYTMusic('next', { videoId });
		if (!ytMusicData?.contents || !ytMusicData?.currentVideoEndpoint) throw new Error('No video details');

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

// Routes

app.get('/search', async (req, res) => {
	const { term, continuation } = req.query;
	if (!term && !continuation) return jsonResponse(res, { error: 'Missing search term' }, 400);
	try {
		const { results, continuation: next } = await searchTracksInternal(term, continuation);
		return jsonResponse(res, { success: true, data: { results, continuation: next } });
	} catch (error) {
		return jsonResponse(res, { error: error.message }, 500);
	}
});

app.get('/track', async (req, res) => {
	const { videoId } = req.query;
	if (!videoId) return jsonResponse(res, { error: 'Missing video ID' }, 400);
	try {
		const { results } = await searchTracksInternal(videoId);
		const result = results.find((item) => item.videoId === videoId) || results[0];
		if (!result) throw new Error('Track not found');
		const parts = result.artists?.split(' • ') || [];
		const duration = parts.pop();
		const artists = parts.join(' • ');
		const { tS, tH } = await fetchAndDeobfuscate(videoId);
		if (!tS || !tH) throw new Error('Failed to fetch deobfuscated result');
		const { playlistId, browseId } = await getRelativeTrackInfo(videoId);
		return jsonResponse(res, {
			success: true,
			data: {
				videoId: result.videoId,
				title: result.title,
				artists,
				duration,
				playsCount: result.playsCount,
				images: result.images,
				playlistId,
				browseId,
				tS,
				tH,
			},
		});
	} catch (error) {
		return jsonResponse(res, { error: error.message }, 500);
	}
});

app.get('/next', async (req, res) => {
	const { videoId, playlistId, playedTrackIds } = req.query;
	if (!videoId || !playlistId) return jsonResponse(res, { error: 'Missing video ID or playlist ID' }, 400);
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
		return jsonResponse(res, { success: true, data: { videoId: nextTrackId } });
	} catch (error) {
		return jsonResponse(res, { error: error.message }, 500);
	}
});

app.get('/lyrics', async (req, res) => {
	const { browseId } = req.query;
	if (!browseId) return jsonResponse(res, { error: 'Missing browse ID' }, 400);
	try {
		const ytMusicData = await fetchYTMusic('browse', { browseId });
		const lyrics = ytMusicData?.contents?.sectionListRenderer?.contents?.[0]?.musicDescriptionShelfRenderer?.description?.runs?.[0]?.text;
		return jsonResponse(res, { success: true, data: lyrics });
	} catch (error) {
		return jsonResponse(res, { error: error.message }, 500);
	}
});

app.get('/suggestions', async (req, res) => {
	const { term } = req.query;
	if (!term) return jsonResponse(res, { error: 'Missing search term' }, 400);
	try {
		const ytMusicData = await fetchYTMusic('music/get_search_suggestions', { input: term });
		const suggestions = ytMusicData?.contents?.[0]?.searchSuggestionsSectionRenderer?.contents
			?.map((content) => ({
				suggestionText: content?.searchSuggestionRenderer?.suggestion?.runs?.[0]?.text,
				suggestionQuery: content?.searchSuggestionRenderer?.navigationEndpoint?.searchEndpoint?.query,
			}))
			.filter(Boolean)
			.slice(0, 5);
		return jsonResponse(res, { success: true, data: { results: suggestions } });
	} catch (error) {
		return jsonResponse(res, { error: error.message }, 500);
	}
});

// Start Server
app.listen(PORT, () => {
	console.log(`Server listening at http://localhost:${PORT}`);
});
