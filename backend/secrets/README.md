# secrets/

运行时密钥目录。`runtime.json` **不进 Git**（已在 .gitignore 排除），但会随 Surf 发布包一起部署
（Surf 发布时会剔除所有 `.env*` 文件，所以生产环境的密钥放在这里）。

`runtime.json` 格式：

```json
{
  "DATABASE_URL": "postgresql://...",
  "HELIUS_API_KEY": "...",
  "ADMIN_PASSWORD": "...",
  "AUTH_SECRET": "...",
  "SURF_API_KEY_FALLBACK": "（可选）平台未注入 SURF_API_KEY 时使用"
}
```

优先级：环境变量 > backend/.env.local / .env > secrets/runtime.json。
不要放 GitHub Token 等生产环境用不到的密钥。
