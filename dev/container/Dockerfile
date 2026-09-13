FROM rocker/r-ver:4.6.1

ARG NODE_VERSION=24.20.0
ARG QUARTO_VERSION=1.10.18
ARG RUST_VERSION=1.95.0
ARG RUSTUP_VERSION=1.28.2
ARG RUSTUP_INSTALLER_SHA256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
ARG RUST_MANIFEST_SHA256=821ff14e4c4a1cbe1e8915f35aff0a3fbbdf8d293ad48ab8f31e3b0440c581f9
ARG USER_UID=1000
ARG USER_GID=1000
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential gfortran cmake pkg-config \
    python3 shellcheck tini pandoc unzip xz-utils \
    libcurl4-openssl-dev libssl-dev libxml2-dev libicu-dev libgit2-dev \
    libfontconfig1-dev libfreetype6-dev libharfbuzz-dev libfribidi-dev \
    libpng-dev libjpeg-dev libtiff-dev libwebp-dev libzmq3-dev libuv1-dev \
    libx11-dev libxt-dev libxext-dev libxrender-dev xvfb xauth \
    fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
    && curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt \
    && grep " node-v${NODE_VERSION}-linux-x64.tar.xz$" SHASUMS256.txt | sha256sum -c - \
    && tar -xJf node-v${NODE_VERSION}-linux-x64.tar.xz -C /usr/local --strip-components=1 \
    && rm node-v${NODE_VERSION}-linux-x64.tar.xz SHASUMS256.txt

RUN curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb \
    && curl -fsSL https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-amd64.deb -o /tmp/quarto.deb \
    && apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb /tmp/quarto.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/chrome.deb /tmp/quarto.deb

RUN Rscript -e 'p <- c("pak", "roxygen2", "rcmdcheck", "BiocManager"); install.packages(p, repos = "https://cloud.r-project.org", Ncpus = 4); stopifnot(all(vapply(p, requireNamespace, logical(1), quietly = TRUE)))'

RUN npm install --global npm@11.4.2

# Build Ark and the native containment helper with the exact upstream Rust toolchain.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init -o /tmp/rustup-init \
    && echo "${RUSTUP_INSTALLER_SHA256}  /tmp/rustup-init" | sha256sum -c - \
    && curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
      https://static.rust-lang.org/dist/channel-rust-${RUST_VERSION}.toml -o /tmp/channel-rust.toml \
    && echo "${RUST_MANIFEST_SHA256}  /tmp/channel-rust.toml" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --default-toolchain ${RUST_VERSION} --profile minimal --no-modify-path \
    && rustup set profile minimal \
    && rustup default ${RUST_VERSION} \
    && chmod -R a+rX /usr/local/rustup /usr/local/cargo \
    && rm -f /tmp/rustup-init /tmp/channel-rust.toml


# Match the checkout owner so builds never leave root-owned source artifacts.
RUN groupadd --gid ${USER_GID} developer \
    && useradd --uid ${USER_UID} --gid ${USER_GID} --create-home --shell /bin/bash developer \
    && mkdir -p /opt/alder-library /workspace/alder \
    && chown -R developer:developer /opt/alder-library /workspace /usr/local/rustup /usr/local/cargo
ENV R_LIBS_USER=/opt/alder-library \
    CHROMOTE_CHROME=/usr/bin/google-chrome
USER developer
WORKDIR /workspace/alder
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["sleep", "infinity"]
