FROM docker.1ms.run/oven/bun:1.3 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

FROM base AS build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ ./src/
RUN bun run build

FROM docker.1ms.run/library/node:24-bookworm-slim AS release

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production
ENV DEBIAN_FRONTEND=noninteractive

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null \
    || sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null \
    || true \
    && apt-get update && apt-get install -y --no-install-recommends \
    curl wget git ca-certificates unzip gnupg \
    openssh-client telnet netcat-openbsd dnsutils iputils-ping \
    python3 python3-pip python3-venv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /var/cache/* \
    && python3 --version

ENV JAVA_HOME=/opt/jdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"
RUN curl -fsSL "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/x64/linux/OpenJDK25U-jdk_x64_linux_hotspot_25.0.3_9.tar.gz" \
    -o /tmp/jdk.tar.gz \
    && mkdir -p /opt/jdk \
    && tar -xz -C /opt/jdk --strip-components=1 -f /tmp/jdk.tar.gz \
    && rm -f /tmp/jdk.tar.gz \
    && rm -rf /opt/jdk/jmods /opt/jdk/include /opt/jdk/demo /opt/jdk/legal \
    && java -version 2>&1 | head -1

ENV MAVEN_VERSION=3.9.15
RUN curl -fsSL "https://mirrors.aliyun.com/apache/maven/maven-3/${MAVEN_VERSION}/binaries/apache-maven-${MAVEN_VERSION}-bin.tar.gz" \
    | tar -xz -C /opt \
    && ln -s "/opt/apache-maven-${MAVEN_VERSION}/bin/mvn" /usr/local/bin/mvn \
    && rm -rf "/opt/apache-maven-${MAVEN_VERSION}/lib/javadoc" \
    && mvn --version

ENV GRADLE_VERSION=9.5.0
RUN curl -fsSL "https://mirrors.cloud.tencent.com/gradle/gradle-${GRADLE_VERSION}-bin.zip" \
    -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm -f /tmp/gradle.zip \
    && rm -rf "/opt/gradle-${GRADLE_VERSION}/src" \
    && gradle --version

RUN mkdir -p /root/.m2 && printf '<?xml version="1.0" encoding="UTF-8"?>\n<settings>\n  <mirrors>\n    <mirror>\n      <id>aliyun</id>\n      <mirrorOf>central</mirrorOf>\n      <url>https://maven.aliyun.com/repository/central</url>\n    </mirror>\n    <mirror>\n      <id>aliyun-public</id>\n      <mirrorOf>public</mirrorOf>\n      <url>https://maven.aliyun.com/repository/public</url>\n    </mirror>\n  </mirrors>\n</settings>\n' > /root/.m2/settings.xml

RUN printf 'allprojects {\n  repositories {\n    maven { url "https://maven.aliyun.com/repository/central" }\n    maven { url "https://maven.aliyun.com/repository/public" }\n    maven { url "https://maven.aliyun.com/repository/google" }\n    maven { url "https://maven.aliyun.com/repository/gradle-plugin" }\n    mavenCentral()\n    google()\n  }\n  buildscript {\n    repositories {\n      maven { url "https://maven.aliyun.com/repository/central" }\n      maven { url "https://maven.aliyun.com/repository/public" }\n      maven { url "https://maven.aliyun.com/repository/google" }\n      maven { url "https://maven.aliyun.com/repository/gradle-plugin" }\n      mavenCentral()\n      google()\n    }\n  }\n}\n' > /root/.gradle/init.gradle

RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g @anthropic-ai/claude-code @openai/codex \
    && npm cache clean --force \
    && rm -rf /root/.npm /tmp/* \
    && claude --version \
    && codex --version

RUN pip3 config set global.index-url https://mirrors.aliyun.com/pypi/simple/ \
    && pip3 config set global.trusted-host mirrors.aliyun.com

RUN curl -fsSL https://opencode.ai/install | bash \
    && if [ -f /root/.opencode/bin/opencode ]; then cp /root/.opencode/bin/opencode /usr/local/bin/opencode; fi \
    && rm -rf /root/.opencode \
    && opencode --version 2>/dev/null || echo "WARN: opencode CLI not installed (SDK will manage server)"

RUN mkdir -p /data /workspace

VOLUME ["/data", "/workspace"]

WORKDIR /workspace

EXPOSE 3000

CMD ["node", "/app/dist/index.js"]
