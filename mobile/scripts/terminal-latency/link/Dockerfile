FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get -o Acquire::Retries=5 update \
  && apt-get install -y --no-install-recommends iproute2 iputils-ping socat ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY link-end.sh /usr/local/bin/link-end
ENTRYPOINT ["/usr/local/bin/link-end"]
