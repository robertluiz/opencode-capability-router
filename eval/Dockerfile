ARG OPENCODE_IMAGE=ghcr.io/anomalyco/opencode:2.3.2
FROM ${OPENCODE_IMAGE}
RUN command -v node >/dev/null || apk add --no-cache nodejs
COPY docker-compaction.mjs /eval/compaction.mjs
COPY docker-indexer-model.mjs /eval/indexer-model.mjs
ENTRYPOINT ["node"]
CMD ["/eval/compaction.mjs"]
