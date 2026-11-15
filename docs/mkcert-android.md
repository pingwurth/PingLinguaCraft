# 安卓真机安装 mkcert 根证书（HTTPS/PWA 联调）

> 状态：2026-11-16 已在安卓真机安装并验证通过。
> 配套：`scripts/dev-https.sh` —— 用 mkcert 给 `localhost + 局域网 IP` 签发证书，起 HTTPS 反代（web 服务本身不支持直接挂证书），手机装一次根证书即可长期使用。

## 背景

PWA 安装到主屏、麦克风权限（跟读录音的 `getUserMedia`）都要求**安全上下文**，局域网 `http://IP:端口` 无法满足；mkcert 签发的证书 SAN 已包含局域网 IP，手机信任其根 CA 后即可无警告访问 `https://<局域网IP>:<端口>`。

## 步骤

### 1. 找到并传输证书

```bash
mkcert -CAROOT        # 输出 CA 目录，Linux 上通常是 ~/.local/share/mkcert
```

目录里的 `rootCA.pem` 即根证书，传到手机（微信/QQ 发给自己、USB、网盘均可）。

### 2. 改扩展名（关键坑）

把 `rootCA.pem` **改名为 `rootCA.crt`**。Android 证书安装器的文件选择器按扩展名过滤，`.pem` 大概率不显示、选不到；内容不用动，Android 认 PEM 格式。

### 3. 安装入口（各厂商叫法不同，任选其一）

- **原生/较新 Android（12+）**：设置 → 安全与隐私 → 更多安全与隐私 → 加密与凭据 → **安装证书 → CA 证书**
- **MIUI/HyperOS**：设置 → 密码与安全 → 系统安全 → 加密与凭据 → 安装证书 → CA 证书
- **通用兜底**：系统「文件」App 里直接点开 `.crt` 文件，Android 11+ 会弹出「安装证书」入口（部分机型比设置里好找）

安装中会遇到两次确认：

1. 「网络可能受到监控」警告 → 选「仍要安装」（用户级 CA 的标准提示，装完通知栏常驻这条属正常）
2. 部分机型要求先有锁屏密码/指纹才能安装凭据 → 没设就先设一个

### 4. 验证

手机 Chrome 访问 `https://<局域网IP>:<端口>`（地址以 `dev-https.sh` 启动打印为准）：

- 不再出现 `NET::ERR_CERT_AUTHORITY_INVALID` → 成功
- 此后 PWA 安装、麦克风等安全上下文功能在手机 Chrome 上可用

## 注意事项

- **只对浏览器/PWA 生效**：Android 7+ 的普通 App 默认不信任用户安装的 CA。手机 Chrome 没问题；但 Expo 真机调试连这个 HTTPS 代理时仍会报证书错误，届时需给 app 配 `networkSecurityConfig`
- **一次安装长期有效**：mkcert 的 rootCA 有效期很长；仅当删除 CAROOT 重新 `mkcert -install` 生成了新 CA 时才需要重传重装
- **iOS 是另一条路**：安装描述文件后，还需在 设置 → 通用 → 关于本机 → 证书信任设置 里对该证书开启完全信任
