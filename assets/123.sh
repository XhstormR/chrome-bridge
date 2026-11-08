#!/usr/bin/env bash

set -euo pipefail

set -xU CA_DIR "$HOME/.chrome-bridge-ca"
set -xU CA_PEM "$CA_DIR/ca.pem"
set -xU BUNDLE "$CA_DIR/bundle.pem"

set -xU PIP_CERT "$BUNDLE"
set -xU SSL_CERT_FILE "$BUNDLE"
set -xU GIT_SSL_CAINFO "$BUNDLE"
set -xU AWS_CA_BUNDLE "$BUNDLE"
set -xU CURL_CA_BUNDLE "$BUNDLE"
set -xU REQUESTS_CA_BUNDLE "$BUNDLE"
set -xU NPM_CONFIG_CAFILE "$BUNDLE"
set -xU NODE_EXTRA_CA_CERTS "$BUNDLE"
set -xU BUNDLE_SSL_CA_CERT "$BUNDLE"

curl -fsSL https://curl.se/ca/cacert.pem -o "$BUNDLE"
cat "$CA_PEM" >> "$BUNDLE"

MacOS:
sudo security add-trusted-cert -d -r trustRoot -p ssl -k /Library/Keychains/System.keychain "$CA_PEM"
sudo security remove-trusted-cert -d "$CA_PEM"
     security find-certificate -c "Chrome Bridge CA" /Library/Keychains/System.keychain

Linux:
limactl shell backup -- sudo cp /Users/leo/.chrome-bridge-ca/ca.pem /etc/pki/ca-trust/source/anchors/chrome-bridge-ca.pem
limactl shell backup -- sudo update-ca-trust extract
limactl shell backup -- trust list | grep 'Chrome Bridge CA'
