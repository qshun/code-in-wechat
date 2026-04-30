# 境外资源与国内镜像对照表

本文档记录 Dockerfile 中使用的所有境外下载源及其对应的国内镜像地址。

---

## 1. Docker 基础镜像

| 资源 | 境外地址 | 国内镜像 | 说明 |
|------|---------|---------|------|
| Bun | `docker.io/oven/bun:1.3` | `docker.1ms.run/oven/bun:1.3` | 构建阶段编译用 |
| Node.js | `docker.io/library/node:24-bookworm-slim` | `docker.1ms.run/library/node:24-bookworm-slim` | 运行时基础镜像 |

### Podman/Docker 镜像仓库加速

配置文件: `~/.config/containers/registries.conf` (Podman) 或 `/etc/docker/daemon.json` (Docker)

```toml
unqualified-search-registries = ["docker.io"]

[[registry]]
prefix = "docker.io"
location = "docker.io"

[[registry.mirror]]
location = "docker.1ms.run"

[[registry.mirror]]
location = "docker.xuanyuan.me"

[[registry.mirror]]
location = "docker.m.daocloud.io"
```

---

## 2. APT 软件源 (Debian Bookworm)

| 资源 | 境外地址 | 国内镜像 |
|------|---------|---------|
| Debian 官方源 | `deb.debian.org` | `mirrors.aliyun.com` |

Dockerfile 中的替换命令:
```dockerfile
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources
```

### 可选镜像源

| 镜像站 | 地址 |
|--------|------|
| 阿里云 | `mirrors.aliyun.com` |
| 清华大学 | `mirrors.tuna.tsinghua.edu.cn` |
| 中科大 | `mirrors.ustc.edu.cn` |
| 华为云 | `repo.huaweicloud.com` |
| 腾讯云 | `mirrors.cloud.tencent.com` |

---

## 3. JDK (OpenJDK 25 - Adoptium/Temurin)

| 资源 | 境外地址 | 国内镜像 |
|------|---------|---------|
| JDK 25 | `adoptium.net/temurin/releases` | `mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/x64/linux/` |

当前版本: `OpenJDK25U-jdk_x64_linux_hotspot_25.0.3_9.tar.gz`

---

## 4. Maven

| 资源 | 境外地址 | 国内镜像 |
|------|---------|---------|
| Maven 二进制 | `archive.apache.org/dist/maven/maven-3/` | `mirrors.aliyun.com/apache/maven/maven-3/` |

当前版本: `3.9.15`

容器内 Maven 镜像配置: `/root/.m2/settings.xml`

---

## 5. Gradle

| 资源 | 境外地址 | 国内镜像 |
|------|---------|---------|
| Gradle 二进制 | `services.gradle.org/distributions/` | `mirrors.cloud.tencent.com/gradle/` |

当前版本: `9.5.0`

容器内 Gradle 镜像配置: `/root/.gradle/init.gradle`

---

## 6. npm

| 资源 | 境外地址 | 国内镜像 |
|------|---------|---------|
| npm registry | `registry.npmjs.org` | `registry.npmmirror.com` |

### 通过 npm 安装的 AI 工具

| 工具 | 包名 |
|------|------|
| Claude Code | `@anthropic-ai/claude-code` |
| OpenAI Codex | `@openai/codex` |

### 可选 npm 镜像源

| 镜像站 | 地址 |
|--------|------|
| 淘宝 (npmmirror) | `https://registry.npmmirror.com` |
| 华为云 | `https://repo.huaweicloud.com/repository/npm/` |
| 腾讯云 | `https://mirrors.cloud.tencent.com/npm/` |

---

## 7. OpenCode

| 资源 | 境外地址 | 国内镜像 |
|------|---------|---------|
| 安装脚本 | `https://opencode.ai/install` (→ `raw.githubusercontent.com`) | GitHub 代理 |
| 二进制 Release | `github.com/anomalyco/opencode/releases` | `ghproxy.com`, `ghgo.xyz` |

OpenCode 安装失败时，可通过 GitHub 代理手动下载:
```bash
curl -fsSL https://ghproxy.com/https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-x86_64.tar.gz | tar xz
sudo mv opencode /usr/local/bin/
```

---

## 8. pip (Python)

| 资源 | 境外地址 | 国内镜像 |
|------|---------|---------|
| PyPI | `pypi.org/simple` | `mirrors.aliyun.com/pypi/simple/` |

容器内已配置: `pip3 config set global.index-url https://mirrors.aliyun.com/pypi/simple/`

### 可选 pip 镜像源

| 镜像站 | 地址 |
|--------|------|
| 阿里云 | `https://mirrors.aliyun.com/pypi/simple/` |
| 清华大学 | `https://pypi.tuna.tsinghua.edu.cn/simple/` |
| 腾讯云 | `https://mirrors.cloud.tencent.com/pypi/simple/` |
| 华为云 | `https://repo.huaweicloud.com/repository/pypi/simple/` |

---

## 9. 网络诊断工具

容器内已安装: `curl`, `wget`, `ssh`, `telnet`, `nc`, `dig`, `nslookup`, `ping`

---

## 快速切换: 全部使用境外源

```dockerfile
# 基础镜像
FROM oven/bun:1.3 AS base
FROM node:24-bookworm-slim AS release

# APT 源
# 删除 apt 源替换行

# JDK
RUN curl -fsSL "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.3%2B9/OpenJDK25U-jdk_x64_linux_hotspot_25.0.3_9.tar.gz" ...

# Maven
RUN curl -fsSL "https://archive.apache.org/dist/maven/maven-3/3.9.15/binaries/apache-maven-3.9.15-bin.tar.gz" ...

# Gradle
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-9.5.0-bin.zip" ...

# npm
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# OpenCode
RUN curl -fsSL https://opencode.ai/install | bash
```
