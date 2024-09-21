import { TWITCH_CLIENT_ID, TWITCH_SHA256_HASH } from '$env/static/private';
import type {
	RecapsQueryResponse,
	SubscriptionsResponse,
	SubscriptionsResponseError,
	FollowsResponse,
	UserSubscriptions,
	CacheData,
} from '$lib/types';
import RedisCacheWorker from '@server/cache';
import { buildAuthorizedHeader } from '@server/utility';

export const TWITCH_GQL_ENDPOINT = 'https://gql.twitch.tv/gql';
const HELIX_FOLLOWED_ENDPOINT = 'https://api.twitch.tv/helix/channels/followed';
const HELIX_SUBSCRIPTIONS_ENDPOINT =
	'https://api.twitch.tv/helix/subscriptions/user';

async function fetchFollows(
	twitchId: string,
	headers: Headers,
	after: string | null = null
): Promise<FollowsResponse> {
	const buildUri = (): string => {
		let uri = `${HELIX_FOLLOWED_ENDPOINT}?user_id=${twitchId}`;
		if (after != null) {
			uri += `&after=${after}`;
		}
		uri += '&first=100';

		return uri;
	};

	const uri = buildUri();
	const following = await fetch(uri, {
		method: 'GET',
		headers: headers,
	});
	const body: FollowsResponse = await following.json();

	// recursively call and merge to build out the `data` field until it
	// is the same length as twitch describes in the `total` field
	if (body.pagination.cursor && body.data && body.total > body.data.length) {
		const next: any = await fetchFollows(
			twitchId,
			headers,
			body.pagination.cursor
		);

		const merged: FollowsResponse = {
			data: [...body.data, ...next.data],
			total: body.total,
			pagination: next.pagination,
		};

		return merged;
	}

	return body;
}

async function fetchSubscriptions(
	twitchId: string,
	broadcasterId: string,
	headers: Headers
): Promise<SubscriptionsResponse | SubscriptionsResponseError> {
	const uri = `${HELIX_SUBSCRIPTIONS_ENDPOINT}?broadcaster_id=${broadcasterId}&user_id=${twitchId}`;
	const res = await fetch(uri, { headers: headers });

	const body: SubscriptionsResponse = await res.json();
	return body;
}

async function fetchRecaps(
	twitchId: string,
	userId: string,
	token: string,
	global: string,
	wants: boolean
) {
	const worker = new RedisCacheWorker({});
	const cachedData = await worker.readData<CacheData>(userId);

	// perform the cache query here rather than in the main
	// server GET func
	if (cachedData) {
		const { following, recaps, subscriptions } = cachedData.data;
		if (wants && following && subscriptions && recaps) {
			worker.close();
			return new Response(null, {
				status: 302,
				headers: {
					Location: '/generate',
				},
			});
		}

		if (!wants && following && subscriptions) {
			worker.close();
			return new Response(null, {
				status: 302,
				headers: {
					Location: '/follows',
				},
			});
		}
	}

	const helixHeaders = buildAuthorizedHeader(token);
	const follows: FollowsResponse = await fetchFollows(twitchId, helixHeaders);
	let subscriptions: Array<UserSubscriptions> = await Promise.all(
		follows.data.map(async (broadcaster) => {
			const res = await fetchSubscriptions(
				twitchId,
				broadcaster.broadcaster_id,
				helixHeaders
			);

			if (!(res as SubscriptionsResponseError).status) {
				const [sub] = (res as SubscriptionsResponse).data;
				return sub;
			}
		})
	).then((res) => {
		return res.filter(Boolean) as UserSubscriptions[];
	});

	// twitch staff do not perceive the rest of this function
	if (wants) {
		const gqlHeaders = buildAuthorizedHeader(
			global,
			true,
			true,
			TWITCH_CLIENT_ID,
			[
				{ 'Content-Type': 'application/json' },
				{ accept: '*/*' },
				{ Host: 'gql.twitch.tv' },
			]
		);

		try {
			const recaps: RecapsQueryResponse[] = await Promise.all(
				subscriptions.map(async (broadcaster) => {
					const [matches] = [
						...new Date()
							.toISOString()
							.matchAll(/(\d{4}-\d{2}-)/gm),
					];
					const currentRecapMonth = matches[0];

					// i dont have any data to cross-reference this with, but i'm pretty
					// sure this query remains largely the same across the board.
					const op = [
						{
							operationName: 'RecapsQuery',
							variables: {
								channelId: `${broadcaster?.broadcaster_id}`,
								endsAt: `${currentRecapMonth}02T00:00:00.000Z`,
							},
							extensions: {
								persistedQuery: {
									version: 1,
									sha256Hash:
										// pretty sure this is used by the GQL server to
										// cache operations
										TWITCH_SHA256_HASH,
								},
							},
						},
					];

					const res = await fetch(TWITCH_GQL_ENDPOINT, {
						method: 'POST',
						headers: gqlHeaders,
						body: JSON.stringify(op),
					});

					const [body]: RecapsQueryResponse[] = await res.json();
					if (!body.data.user.self.recap.minutesWatched) {
						body.data.user.self.recap.minutesWatched = '0';
					}

					return body;
				})
			);

			await worker.writeData<CacheData>(userId, {
				id: userId,
				data: {
					following: follows.data,
					subscriptions: subscriptions,
					recaps: recaps,
				},
			});

			worker.close();
			return new Response(null, {
				status: 302,
				headers: {
					Location: '/generate',
				},
			});
		} catch (err) {
			console.log(err);
			if (err instanceof TypeError) {
				// TypeError means this was probably a bad token;
				// shouldnt happen (we verify it prior to running all of this)
				// but we can handle it anyway.
				worker.close();
				return new Response(null, {
					status: 300,
					headers: {
						Location: '/?e=bad_global_token',
					},
				});
			}

			worker.close();
			console.error('[!] issue while fetching recap:', err);
		}

		// else block is essentially
		//  `if (!wants) { ...`
	} else {
		const worker = new RedisCacheWorker({});
		await worker.writeData<CacheData>(userId, {
			id: userId,
			data: {
				following: follows.data,
				subscriptions: subscriptions,
				recaps: null,
			},
		});

		worker.close();
	}
}

export { fetchRecaps, fetchFollows, fetchSubscriptions };
