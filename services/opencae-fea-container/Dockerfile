FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends calculix-ccx ca-certificates python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opencae
COPY runner.py /opencae/runner.py

EXPOSE 8080
CMD ["python3", "/opencae/runner.py"]
