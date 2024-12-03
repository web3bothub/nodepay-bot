import asyncio
import aiohttp
import logging
import random
import os
import time
import sys
import json
from pathlib import Path
import cloudscraper

# Global constants
DOMAIN_API = {
    'SESSION': 'http://api.nodepay.ai/api/auth/session',
    'PING': [
        "https://nw.nodepay.org/api/network/ping",
    ]
}

PING_INTERVAL = 180  # seconds

# Connection states
from enum import Enum

scraper = cloudscraper.create_scraper(
    browser={
        'browser': 'chrome',
        'platform': 'windows',
        'desktop': True
    }
)


class ConnectionStates(Enum):
    CONNECTED = 1
    DISCONNECTED = 2
    NONE_CONNECTION = 3


# Logger configuration function to add an account prefix
def create_logger(account_identifier):
    logger = logging.getLogger(f'token:{account_identifier}')
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler()
    formatter = logging.Formatter(
        '%(asctime)s | [%(name)s] %(levelname)s: %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S')
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger


def get_random_user_agent():
    user_agents = [
        # A list of common user agents
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
        ' Chrome/58.0.3029.110 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko)'
        ' Chrome/61.0.3163.100 Safari/537.36',
        'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
        ' Chrome/41.0.2228.0 Safari/537.36',
        # Add more user agents here
    ]
    return random.choice(user_agents)


async def get_ip_address(proxy):
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get('https://api.ipify.org?format=json', proxy=proxy, timeout=5) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get('ip')
    except Exception as e:
        return None


class AccountSession:
    def __init__(self, token, account_id):
        self.account_id = account_id
        self.token = token
        self.browser_ids = []
        self.account_info = {}
        self.proxy_auth_status = False
        self.status_connect = ConnectionStates.NONE_CONNECTION
        self.retries = 0
        self.last_ping_time = 0
        self.proxies = []
        self.user_agent = get_random_user_agent()
        self.logger = create_logger(f'token:{account_id}')

    async def init(self):
        try:
            await self.get_proxies()
            self.format_stats()
            await self.authenticate()
            await self.ping()
            self.start_ping_loop()
        except Exception as error:
            self.logger.error(f"Initialization error: {error}")

    def format_stats(self):
        for index, proxy in enumerate(self.proxies):
            self.browser_ids.append({
                'ping_count': 0,
                'successful_pings': 0,
                'score': 0,
                'start_time': time.time(),
                'last_ping_time': None
            })

    async def get_proxies(self):
        try:
            account_proxy_path = Path(f'./proxies/{self.account_id}.txt')
            proxy_data = ''
            if account_proxy_path.is_file():
                async with aiofiles.open(account_proxy_path, 'r') as f:
                    proxy_data = await f.read()
            else:
                root_proxy_path = Path('./proxies.txt')
                self.logger.info(f"Account-specific proxy file({account_proxy_path}) not found, trying {root_proxy_path} instead.")
                if root_proxy_path.is_file():
                    async with aiofiles.open(root_proxy_path, 'r') as f:
                        proxy_data = await f.read()
                else:
                    raise FileNotFoundError('No proxies found in either account-specific or root proxy file')
            self.proxies = [line.strip() for line in proxy_data.splitlines() if line.strip()]
            if not self.proxies:
                raise ValueError('No proxies found in either account-specific or root proxy file')
            self.logger.info(f"Loaded {len(self.proxies)} proxies for account token {self.account_id}.")
        except Exception as error:
            self.logger.error(f"Failed to load proxies: {error}")
            raise

    async def authenticate(self):
        for proxy in self.proxies:
            try:
                if not self.proxy_auth_status:
                    self.logger.info(f"Authenticating with proxy {proxy}")
                    ip_address = await get_ip_address(proxy)
                    self.logger.info(f"IP address: {ip_address}")

                    response = await self.perform_request(DOMAIN_API['SESSION'], {}, proxy)
                    if not response:
                        continue

                    if response.get('code') != 0:
                        self.logger.error(f"Failed to authenticate with proxy {proxy}: {response}, response.code is not 0")
                        self.handle_logout(proxy)
                        continue

                    self.account_info = response.get('data', {})
                    if 'uid' in self.account_info:
                        self.proxy_auth_status = True
                        self.save_session_info()
                        self.logger.info(f"Authenticated with proxy {proxy}")
                    else:
                        self.logger.error(f"Failed to authenticate with proxy {proxy}: {self.account_info}, response.data.uid is not found")
                        self.handle_logout(proxy)
                        continue
            except Exception as error:
                self.logger.error(f"Failed to authenticate with proxy: {proxy}: {error}")

    async def perform_request(self, url, data, proxy, max_retries=3):
        headers = {
            'Authorization': f'Bearer {self.token}',
            'Content-Type': 'application/json',
            'Origin': 'chrome-extension://lgmpfmgeabnnlemejacfljbmonaomfmm',
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.5",
            "Sec-Ch-Ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
            "Sec-Ch-Ua-Mobile": "?0",
            "Sec-Ch-Ua-Platform": "Windows",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "cors-site",
            "Priority": "u=1, i",
            "Referer": "https://app.nodepay.ai/",
        }

        for attempt in range(max_retries):
            try:
                proxies = {"http": proxy, "https": proxy} if proxy else None

                self.logger.info(f"Using proxy {proxy} for request to {url}")
                self.logger.info(f"Performing request to {url} with data: {json.dumps(data)}")

                response = scraper.post(url, json=data, headers=headers, proxies=proxies, timeout=30)
                self.logger.info(f"Response: {response.text}")

                if response.status_code == 200:
                    return response.json()
                else:
                    self.logger.error(f"API call failed to {url} for proxy {proxy}: HTTP {response.status_code}")
                    if response.status_code == 403:
                        return None
            except Exception as error:
                self.logger.error(f"API call failed to {url} for proxy {proxy}: {error}")
                await asyncio.sleep(2 ** attempt)
        self.logger.error(f"API call failed to {url} after {max_retries} attempts for proxy {proxy}")
        return None

    def start_ping_loop(self):
        self.logger.info(f"Ping loop started with interval {PING_INTERVAL} seconds")
        asyncio.create_task(self.ping_loop())

    async def ping_loop(self):
        while True:
            await self.ping()
            await asyncio.sleep(PING_INTERVAL)

    async def ping(self):
        current_time = time.time()
        if current_time - self.last_ping_time < PING_INTERVAL:
            self.logger.info(f"Skipping ping for account {self.account_id} as interval has not elapsed yet")
            return

        self.last_ping_time = current_time

        for index, proxy in enumerate(self.proxies):
            self.browser_ids[index]['last_ping_time'] = current_time
            try:
                data = {
                    'id': self.account_info.get('uid'),
                    'browser_id': self.browser_ids[index],
                    'timestamp': int(current_time),
                    # 'version': '2.2.7'
                }
                ping_success = False
                for ping_api in DOMAIN_API['PING']:
                    self.logger.info(f"Pinging [{ping_api}] for proxy {proxy}")
                    response = await self.perform_request(ping_api, data, proxy)
                    print(response)
                    self.logger.info(f"Ping response: {response}")

                    # Update ping stats
                    self.browser_ids[index]['ping_count'] += 1

                    if response and response.get('data') and response.get('code') == 0:
                        self.retries = 0
                        self.status_connect = ConnectionStates.CONNECTED
                        ping_success = True
                        self.browser_ids[index]['successful_pings'] += 1
                        self.logger.info(f"Ping successful for proxy {proxy}, network score: {response['data'].get('ip_score', 0)}")
                        break
                if not ping_success:
                    self.logger.error(f"Ping failed for proxy {proxy}, tried all endpoints.")
                    self.handle_ping_fail(proxy, None)
            except Exception as error:
                self.logger.error(f"Ping failed for proxy {proxy}: {error}")
                self.handle_ping_fail(proxy, None)

    def handle_ping_fail(self, proxy, response):
        self.retries += 1
        if response and response.get('code') == 403:
            self.handle_logout(proxy)
        elif self.retries >= 2:
            self.status_connect = ConnectionStates.DISCONNECTED

    def handle_logout(self, proxy):
        self.status_connect = ConnectionStates.NONE_CONNECTION
        self.account_info = {}
        self.proxy_auth_status = False
        self.logger.info(f"Logged out and cleared session info for proxy {proxy}")

    def save_session_info(self):
        # Placeholder for saving session info if needed
        pass


async def load_tokens():
    try:
        async with aiofiles.open('tokens.txt', 'r') as f:
            tokens_data = await f.read()
            tokens = [line.strip().strip("'\"") for line in tokens_data.splitlines() if line.strip()]
            return tokens
    except Exception as error:
        print(f"Failed to load tokens: {error}")
        raise


async def main():
    print("""
     _  __        __    ___            ___       __
    / |/ /__  ___/ /__ / _ \\___ ___ __/ _ )___  / /_
   /    / _ \\/ _  / -_) ___/ _ `/ // / _  / _ \\/ __/
  /_/|_/\\___/\\_,_/\\__/_/   \\_,_/\\_, /____/\\___/\\__/
                               /___/
-----------------------------------------------------
|           NodePay bot by @overtrue                 |
|     Telegram: https://t.me/+ntyApQYvrBowZTc1       |
| GitHub: https://github.com/web3bothub/nodepay-bot  |
------------------------------------------------------
""")
    print('Starting program...')
    await asyncio.sleep(3)
    try:
        tokens = await load_tokens()
        sessions = []
        for index, token in enumerate(tokens, start=1):
            session = AccountSession(token, index)
            await session.init()
            sessions.append(session)
            await asyncio.sleep(10)
        # Keep the program running
        await asyncio.Event().wait()
    except Exception as error:
        print(f"Program terminated: {error}")


if __name__ == '__main__':
    import aiofiles

    asyncio.run(main())
