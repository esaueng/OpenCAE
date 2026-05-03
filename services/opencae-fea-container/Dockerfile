FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends calculix-ccx ca-certificates gmsh python3 \
  && mkdir -p /opencae/licenses \
  && (cp /usr/share/common-licenses/GPL-2 /opencae/licenses/GPL-2.txt || true) \
  && (cp /usr/share/common-licenses/LGPL-2.1 /opencae/licenses/LGPL-2.1.txt || true) \
  && (cp /usr/share/doc/calculix-ccx/copyright /opencae/licenses/calculix-ccx-debian-copyright || true) \
  && (cp /usr/share/doc/gmsh/copyright /opencae/licenses/gmsh-debian-copyright || true) \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opencae
COPY runner.py /opencae/runner.py
COPY RUNNER_VERSION /opencae/RUNNER_VERSION

EXPOSE 8080
CMD ["python3", "/opencae/runner.py"]
