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
    return json({ error: 'invalid path' }, 404)
  }
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
    return json({ error: 'CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET 未配置' }, 500)
  }
  const upstream = await fetch(`${DATA_ORIGIN}/${path}`, {
    headers: {
      'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    },
  })
  if (!upstream.ok || !upstream.headers.get('content-type')?.includes('json')) {
    return json({ error: `数据源响应异常：HTTP ${upstream.status}（${upstream.headers.get('content-type') ?? '未知类型'}）` }, 502)
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': upstream.headers.get('cache-control') ?? 'no-store',
    },
  })
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
