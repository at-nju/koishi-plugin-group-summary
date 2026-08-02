interface Env {
  CF_ACCESS_CLIENT_ID: string
  CF_ACCESS_CLIENT_SECRET: string
}

const DATA_ORIGIN = 'https://summary-db.210023.xyz/group-summary'

export const onRequestGet = async ({ params, env }: {
  params: { path?: string | string[] }
  env: Env
}) => {
  const segments = Array.isArray(params.path) ? params.path : [params.path].filter((p): p is string => !!p)
  const path = segments.join('/')
  if (!path || path.split('/').some(part => part === '..' || part === '')) {
    return new Response('Not Found', { status: 404 })
  }
  const upstream = await fetch(`${DATA_ORIGIN}/${path}`, {
    headers: {
      'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    },
  })
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
    },
  })
}
