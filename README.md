# 智能材料测验网站

上传 PDF、DOCX、PPTX 后，系统会先在本地提取可复制文字，再使用用户在首页选择的 AI 生成中文材料摘要、知识点、选择题测试或开放式追问。第一版不做登录和长期数据库，上传文件与生成结果只保存在当前服务运行期间。

完整需求见 [PRODUCT_REQUIREMENTS.md](./PRODUCT_REQUIREMENTS.md)。

## 重要说明

本项目支持两种 AI：

- `DeepSeek`：默认模型，使用 `deepseek-v4-flash`，并在后端加入低成本模型保护。
- `GPT-5.5`：可选高质量模型，使用 OpenAI Responses API。它不是免费模型，需要可用的 OpenAI API Key 和 API 额度。

DeepSeek 官方 API 是按 token 计费，并从充值余额或赠送余额扣除；它不是稳定意义上的永久免费服务。如果你的 DeepSeek 账号有赠送余额，调用会优先消耗赠送余额。

当前版本会提取 PDF/DOCX/PPTX 中可复制的文字，再交给所选 AI 分析；扫描版文字、复杂图示和图片含义识别仍受本地提取能力限制。

## 本地运行

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 在 `.env` 中填入 API Key：

```bash
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
OPENAI_API_KEY=你的 OpenAI API Key
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=low
PORT=5174
```

如果暂时不使用 GPT-5.5，可以不填 `OPENAI_API_KEY`；首页会显示 GPT-5.5 未配置。

3. 启动前后端：

```bash
npm run dev
```

前端默认运行在 `http://localhost:5173`，后端 API 默认运行在 `http://localhost:5174`。

## 生产运行

构建前端：

```bash
npm run build
```

启动 Node 服务：

```bash
npm run start
```

生产模式下，后端会在同一个端口托管 `dist` 前端静态文件和 `/api` 接口。

## 临时公开访问

如果只想短时间给别人试用，可以在本机服务运行时开启 Cloudflare 临时隧道：

```bash
cloudflared tunnel --url http://localhost:5174
```

命令输出的 `https://*.trycloudflare.com` 地址即可公开访问。这个地址依赖你的电脑、Node 服务和隧道命令持续运行，不能作为长期生产地址。

## Render 部署

项目已包含 `render.yaml`，可以作为 Render Blueprint 部署。

推荐配置：

- Build Command: `npm ci --include=dev && npm run build`
- Start Command: `npm run start`
- Health Check Path: `/api/health`
- Environment:
  - `DEEPSEEK_API_KEY`: 你的 DeepSeek API Key
  - `DEEPSEEK_MODEL`: `deepseek-v4-flash`
  - `OPENAI_API_KEY`: 你的 OpenAI API Key
  - `OPENAI_MODEL`: `gpt-5.5`
  - `OPENAI_REASONING_EFFORT`: `low`
  - `NODE_ENV`: `production`

部署后，Render 提供的公网域名会同时托管页面和 `/api` 接口。

## 支持范围

- 文件格式：PDF、DOCX、PPTX。
- 单个文件不超过 50MB。
- PDF 不超过 100 页。
- PPTX 不超过 100 页幻灯片。
- 题目数量：5、10、15、20、30。
- 难度：简单、中等、困难。
