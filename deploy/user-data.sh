#!/bin/bash
set -eux
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io docker-compose-v2 fail2ban unattended-upgrades
systemctl enable --now docker fail2ban
# 2 GB swap: headroom for image loads on a 2 GB instance
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
usermod -aG docker ubuntu
mkdir -p /opt/sds && chown ubuntu:ubuntu /opt/sds
touch /opt/sds/.ready
