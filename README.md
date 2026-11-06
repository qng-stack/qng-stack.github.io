# qng-stack 的笔记站

Astro 静态博客，推送到 `main` 后由 GitHub Actions 发布到 GitHub Pages。

发布地址：https://qng-stack.github.io/

## 本地

```sh
npm install
npm run dev
npm run build
```

开发地址是 http://localhost:4321/ 。

## 发布

1. 在 GitHub 用户 `qng-stack` 下新建公开仓库，仓库名必须是 `qng-stack.github.io`。
2. 把这个目录推送到该仓库的 `main` 分支，并带上 `package-lock.json`。
3. 打开仓库 Settings → Pages，Source 选择 GitHub Actions。
4. 之后每次推送到 `main`，`.github/workflows/deploy.yml` 会自动构建并发布。

新文章放在 `src/content/blog/`，使用 `.md` 或 `.mdx`。
