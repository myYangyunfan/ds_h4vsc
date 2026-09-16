安装内核并配置 API Key，两步完成。

1. **内核（dsh）**：命令面板执行 `DeepSeek Harness: 安装内核（dsh）`，扩展会自动安装内核并创建 ACP profile；也可以自行 `npm install -g @deepseek-ai/dsh`（需 0.1.2+）
2. **API Key**：命令面板执行 `DeepSeek Harness: 设置 API Key`，密钥保存在系统密钥库（SecretStorage），绝不写入设置文件；或在对话里输入 `/login` 走登录流程

完成后直接对话即可，例如："分析这个仓库的整体架构"。

Install the kernel via the command palette, then set your DeepSeek API key (stored in SecretStorage).
