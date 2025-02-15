# base image
FROM python:3.9-bullseye

# set working directory
WORKDIR /app

# copy requirements.txt
COPY requirements.txt .

# install dependencies
RUN apt-get update 
RUN apt-get install -y apt-utils
RUN apt-get install -y wget unzip fontconfig fonts-liberation fonts-wqy-zenhei fonts-arphic-uming

RUN pip install --no-cache-dir -r requirements.txt
RUN wget https://github.com/wkhtmltopdf/packaging/releases/download/0.12.6.1-2/wkhtmltox_0.12.6.1-2.bullseye_amd64.deb
RUN apt-get install -y ./wkhtmltox_0.12.6.1-2.bullseye_amd64.deb

# Download and install Buckeye Serif 2 Regular & Bold fonts
RUN wget -O /usr/local/share/fonts/BuckeyeSerif2-Regular.otf "https://pages-4os.pages.dev/BuckeyeSerif2-Regular.otf" \
    && wget -O /usr/local/share/fonts/BuckeyeSerif2-Bold.otf "https://pages-4os.pages.dev/BuckeyeSerif2-Bold.otf" \
    && fc-cache -fv

# copy source code
COPY . .

EXPOSE 8080

CMD ["gunicorn", "app:app", "--workers", "4", "--worker-class", "app.ConfigurableWorker", "--bind", "0.0.0.0:8080", "--forwarded-allow-ips","*"]

