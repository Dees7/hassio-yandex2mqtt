## Установка в venv
git clone https://github.com/munrexio/yandex2mqtt.git /opt/yandex2mqtt
sudo chown -R pi:pi /opt/yandex2mqtt
cd /opt/yandex2mqtt
python3 -m venv .
source /opt/yandex2mqtt/bin/activate
pip install --upgrade pip wheel setuptools
pip install nodeenv
nodeenv -p -n 10.15.1
deactivate
source /opt/yandex2mqtt/bin/activate
cd /opt/yandex2mqtt/y2m
npm ci
#npm install
npm install pm2 -g


