FROM node:20-bullseye

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    wget \
    unzip \
    fontconfig \
    fonts-liberation \
    fonts-wqy-zenhei \
    fonts-arphic-uming \
  && wget https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-2/wkhtmltox_0.12.6.1-2.bullseye_amd64.deb \
  && apt-get install -y ./wkhtmltox_0.12.6.1-2.bullseye_amd64.deb \
  && rm -f wkhtmltox_0.12.6.1-2.bullseye_amd64.deb \
  && rm -rf /var/lib/apt/lists/*

RUN wget -O /usr/local/share/fonts/BuckeyeSerif2-Regular.otf "https://pages-4os.pages.dev/BuckeyeSerif2-Regular.otf" \
    && wget -O /usr/local/share/fonts/BuckeyeSerif2-Bold.otf "https://pages-4os.pages.dev/BuckeyeSerif2-Bold.otf" \
    && fc-cache -fv

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
