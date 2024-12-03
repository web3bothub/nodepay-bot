FROM python:3

ENV USER_ID=

WORKDIR /app

ADD . /app/

# install dependencies
RUN pip install -r requirements.txt
RUN chmod +x /app/entrypoint.sh

CMD ["/bin/bash", "/app/entrypoint.sh"]
