FROM eclipse-temurin:21-jdk

RUN apt-get update \
    && apt-get install --no-install-recommends -y python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /runner
COPY server.py .
COPY src ./src

RUN mkdir classes \
    && javac --add-modules jdk.jdi -g -d classes src/JdiTracer.java

RUN useradd --create-home --uid 10001 runner \
    && chown -R runner:runner /runner
USER runner

ENV PORT=7000
EXPOSE 7000
ENTRYPOINT ["python3", "/runner/server.py"]
