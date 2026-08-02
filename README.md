# koishi-plugin-group-summary

为一个指定群聊周期性生成话题摘要，并把公开数据发布到 Cloudflare R2。Pages 只托管静态阅读界面。

## 开发

```sh
npm install --workspaces=false
npm run build
```

## Cloudflare 初始化

先登录并创建资源：

```sh
npx wrangler login
npx wrangler r2 bucket create group-summary
npx wrangler pages project create group-summary --production-branch main
```

为 R2 bucket 开启公开自定义域名，或仅在测试时开启 `r2.dev`：

```sh
npx wrangler r2 bucket domain add group-summary --domain data.example.com --zone-id YOUR_ZONE_ID --min-tls 1.2
# 测试替代：npx wrangler r2 bucket dev-url enable group-summary
```

将 [cloudflare/cors.json](./cloudflare/cors.json) 中的站点域名改成实际 Pages 域名，再应用 CORS：

```sh
npx wrangler r2 bucket cors set group-summary --file cloudflare/cors.json
```

将 [site/index.html](./site/index.html) 中的 `group-summary-data` 改成 R2 公开域名与插件配置的快照前缀，然后部署网页外壳：

```sh
npm run deploy:site
```

最后在 Cloudflare Pages 控制台绑定公开站点域名。R2 API token 只需要目标 bucket 的 Object Read & Write 权限，不要把 token 写入仓库。

## Koishi 配置

构建插件并在 Koishi 中启用 `group-summary`。必填配置分为三组：

- 目标群：平台与频道 ID；
- 模型：OpenAI 兼容 `baseUrl`、`apiKey`、`model`；
- 发布：R2 `accountId`、`bucket`、访问密钥和可选前缀。

插件默认每十分钟处理一次，实时事件负责收集，OneBot 历史接口负责启动和周期性查漏。没有新消息时不会调用模型。
