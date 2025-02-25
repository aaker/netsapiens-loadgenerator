FROM node
ENV PATH="/usr/local/bin:${PATH}"
RUN apt-get update -y && apt-get upgrade -y && apt-get install -y \
    git dnsutils cron rsync nodejs npm memcached vim iputils-ping 2to3 python-is-python3 bc openssl \
    build-essential libssl-dev libncurses5-dev libpcap-dev autoconf automake libtool cmake libgsl-dev \
    pkg-config dh-autoreconf libsctp-dev lksctp-tools

# RUN groupadd loadgenerator
# RUN useradd --gid loadgenerator --shell /bin/bash --create-home loadgenerator

RUN mkdir -p /usr/local/NetSapiens/netsapiens-loadgenerator
# RUN chown -R loadgenerator:loadgenerator /usr/local/NetSapiens/netsapiens-loadgenerator
RUN mkdir -p /var/log/netsapiens-loadgenerator
# RUN chown -R loadgenerator:loadgenerator /var/log/netsapiens-loadgenerator
RUN touch /var/log/cron.log && touch /var/log/netsapiens-loadgenerator/sipp.log
# RUN chown -R loadgenerator:loadgenerator /var/log/cron.log /var/log/netsapiens-loadgenerator/sipp.log

# Clone SIPp from source, build it with TLS support, and install it
WORKDIR /usr/src
RUN git clone https://github.com/SIPp/sipp.git && \
    cd sipp && \
    git checkout v3.7.3 && \
    cmake . -DUSE_SSL=1 -DUSE_SCTP=1 -DUSE_PCAP=1 -DUSE_GSL=1 && \
    make && \
    make install

# Generate TLS certificates for SIPp scripts
RUN mkdir -p /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/certs
WORKDIR /usr/local/NetSapiens/netsapiens-loadgenerator/sipp/certs
RUN openssl req -x509 -newkey rsa:4096 -keyout cakey.pem -out cacert.pem -days 4096 -nodes -subj "/CN=localhost"

WORKDIR /usr/local/NetSapiens/netsapiens-loadgenerator
COPY package*.json ./
RUN npm install

# RUN ln -sf /usr/local/NetSapiens/netsapiens-loadgenerator/cron/start_sipp /etc/cron.d/start_sipp

COPY . .
# RUN chown -R loadgenerator:loadgenerator /usr/local/NetSapiens/netsapiens-loadgenerator
# USER loadgenerator

CMD ["node", "server.js"]