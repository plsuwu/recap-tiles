import { twitch } from '@server/auth';
import RedisCacheWorker from '@server/cache';
import { redirect, type RequestEvent } from '@sveltejs/kit';
import { generateState } from 'arctic';

export const GET = async (event: RequestEvent): Promise<Response> => {
    const id = event.locals.user?.id;
    const refreshToken = event.locals.user?.refresh;
    const refreshAfter = event.locals.user?.refresh_after;
    if (
        id &&
        refreshToken &&
        refreshAfter &&
        Number(refreshAfter) <= Date.now()
    ) {
        const refreshed = await twitch.refreshAccessToken(refreshToken);
        const refreshedUser = {
            id,
            twitch_id: event.locals.user?.twitch_id,
            login: event.locals.user?.login,
            color: event.locals.user?.color,
            profile_image_url: event.locals.user?.profile_image_url,
            display_name: event.locals.user?.display_name,
            access: refreshed.accessToken,
            refresh: refreshed.refreshToken,
            refresh_after: Date.parse(
                refreshed.accessTokenExpiresAt.toString()
            ),
        };

        const worker = new RedisCacheWorker({});
        await worker.delete(id);
        await worker.writeUser(id, refreshedUser);
        worker.close();
    }

    const state = generateState();
    const scopes = {
        scopes: ['user:read:follows', 'user:read:subscriptions'],
    };

    const url = await twitch.createAuthorizationURL(state, scopes);
    event.cookies.set('oauth_state', state, {
        path: '/',
        secure: import.meta.env.PROD,
        httpOnly: true,
        maxAge: 60 * 10,
        sameSite: 'lax',
    });

    redirect(302, url.toString());
};
