FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
ARG SITE_REVISION
WORKDIR /site
COPY . .
RUN node build.mjs --out /public --revision "$SITE_REVISION"

FROM nginx:alpine@sha256:db35bfc6b2951e7f8a72db5db120288c127ffaeeb4a6d4b95a26fead017d5913
ARG SITE_REVISION
LABEL org.opencontainers.image.revision=$SITE_REVISION
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /public /usr/share/nginx/html
COPY --from=build /public/.clio-redirects.conf /etc/nginx/clio-redirects.conf
COPY --from=build /public/.clio-revision.conf /etc/nginx/clio-revision.conf
