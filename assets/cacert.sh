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
limactl shell default -- sudo cp /Users/leo/.chrome-bridge-ca/ca.pem /etc/pki/ca-trust/source/anchors/chrome-bridge-ca.pem
limactl shell default -- sudo update-ca-trust extract
limactl shell default -- trust list | grep 'Chrome Bridge CA'

Java 自签名证书配置:
set -xU JAVA_TRUSTSTORE "$CA_DIR/java-cacerts.p12"
set -xU JAVA_TRUSTSTORE_PASSWORD "changeit"
# 复制 JDK 默认证书库，然后导入自签名证书
cp "/Users/leo/.pixi/envs/graalvm/lib/security/cacerts" "$JAVA_TRUSTSTORE"
keytool -importcert \
    -noprompt \
    -trustcacerts \
    -alias chrome-bridge-ca \
    -file "$CA_PEM" \
    -keystore "$JAVA_TRUSTSTORE" \
    -storepass "$JAVA_TRUSTSTORE_PASSWORD" \
    -storetype PKCS12
keytool -list \
    -alias chrome-bridge-ca \
    -keystore "$JAVA_TRUSTSTORE" \
    -storepass "$JAVA_TRUSTSTORE_PASSWORD" \
    -storetype PKCS12
# 使用自签名证书配置
set -xU JAVA_TOOL_OPTIONS \
    "-Djavax.net.ssl.trustStore=$JAVA_TRUSTSTORE -Djavax.net.ssl.trustStorePassword=$JAVA_TRUSTSTORE_PASSWORD -Djavax.net.ssl.trustStoreType=PKCS12"
