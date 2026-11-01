# Dev server image. The context is laid out by src/dev/image.ts: bin/ (jars,
# libraries/, versions/, cache/), cfg/ (the rest of server/), ovr/ (dev
# overrides). Separate COPY layers, so a config-only commit reuses the jar layer.
FROM eclipse-temurin:25-jre@sha256:ecdc0adb37bde1a281c4d245a3cd535004b1fc8322d560f5b09463b248c81df0

# The volume takes its owner from this directory on first mount.
RUN install -d -o 1000 -g 1000 /server
COPY --chown=1000:1000 bin /server/
COPY --chown=1000:1000 cfg /server/
COPY --chown=1000:1000 ovr /server/
COPY entrypoint.sh /usr/local/bin/mc-entrypoint

ARG MC_JAR
ENV MC_JAR=$MC_JAR JAVA_OPTS="-Xms512M -Xmx2G"
USER 1000:1000
WORKDIR /server
EXPOSE 25565
ENTRYPOINT ["mc-entrypoint"]
