import datetime
import json
from redis import asyncio as aioredis
import asyncio
import pdfkit

from quart import render_template, request, make_response, jsonify, session, websocket

from . import imb
from . import config
from . import usps_api
from . import app

ROLLING_WINDOW = 50
SERIAL_MAX = 10000

redis_client = aioredis.Redis(host=config.REDIS_HOST, port=6379, db=0)


@app.before_serving
async def server_init():
    async def token_maintain():
        while True:
            await usps_api.iv_token_maintain()
            await usps_api.new_api_token_maintain()
            await asyncio.sleep(5 * 60)
    app.add_background_task(token_maintain)


@app.after_serving
async def server_shutdown():
    await redis_client.close()
    await usps_api.close_redis_client()
    await usps_api.close_httpx_client()


async def generate_serial():
    today = datetime.datetime.today()
    num_days = (today - datetime.datetime(1970, 1, 1)).days
    base = num_days % ROLLING_WINDOW
    day_key = "serial_" + str(base)
    perday_counter = await redis_client.incr(day_key)
    if perday_counter >= SERIAL_MAX:
        raise ValueError("Daily serial capacity exhausted")
    await redis_client.expire(day_key, 48 * 60 * 60)
    return base * SERIAL_MAX + int(perday_counter)


def _mailer_id_is_nine_digit() -> bool:
    return str(config.MAILER_ID).startswith('9')


def _tracking_digits(serial: int) -> str:
    """20-digit tracking portion of the IMb (barcode_id + svc + mailer + serial)."""
    if _mailer_id_is_nine_digit():
        return f"{config.BARCODE_ID:02d}{config.SRV_TYPE:03d}{config.MAILER_ID:09d}{serial:06d}"
    return f"{config.BARCODE_ID:02d}{config.SRV_TYPE:03d}{config.MAILER_ID:06d}{serial:09d}"


def generate_human_readable(receipt_zip: str, serial: int) -> str:
    if _mailer_id_is_nine_digit():
        mailer = f"{config.MAILER_ID:09d}"
        serial_str = f"{serial:06d}"
    else:
        mailer = f"{config.MAILER_ID:06d}"
        serial_str = f"{serial:09d}"
    return f"{config.BARCODE_ID:02d}-{config.SRV_TYPE:03d}-{mailer}-{serial_str}-{receipt_zip}"


@app.route('/')
async def index():
    return await render_template('index.html')


@app.route('/generate', methods=['POST'])
async def generate():
    form = await request.form
    sender_address = form.get('sender_address', '').strip()
    recipient_name = form.get('recipient_name', '').strip()
    recipient_company = form.get('recipient_company', '').strip()
    recipient_street = form.get('recipient_street', '').strip()
    recipient_address2 = form.get('recipient_address2', '').strip()
    recipient_city = form.get('recipient_city', '').strip()
    recipient_state = form.get('recipient_state', '').strip().upper()
    zip_raw = form.get('recipient_zip', '')
    zip_digits = ''.join(ch for ch in zip_raw if ch.isdigit())
    if len(zip_digits) not in (5, 9, 11):
        return "Invalid recipient zip: must be 5, 9, or 11 digits", 400
    if not recipient_name or not recipient_street or not recipient_city or not recipient_state:
        return "Missing required recipient fields", 400
    zip5 = zip_digits[:5]
    zip_full = zip5
    if len(zip_digits) >= 9:
        zip_full = f"{zip5}-{zip_digits[5:9]}"
    recipient_address_parts = [
        recipient_name,
        recipient_company,
        recipient_street,
        recipient_address2,
        f"{recipient_city}, {recipient_state} {zip_full}",
    ]
    recipient_address = '\n'.join(filter(bool, recipient_address_parts))
    serial = await generate_serial()
    session['sender_address'] = sender_address
    session['recipient_address'] = recipient_address
    session['serial'] = serial
    session['recipient_zip'] = zip_digits
    return await render_template('generate.html', serial=serial, recipient_zip=zip_digits)


PDF_OPTIONS = {
    'envelope': {
        'page-height': '4.125in',
        'page-width': '9.5in',
        'margin-bottom': '0in',
        'margin-top': '0in',
        'margin-left': '0in',
        'margin-right': '0in',
        'disable-smart-shrinking': '',
    },
    'avery': {
        'page-height': '11in',
        'page-width': '8.5in',
        'margin-bottom': '0in',
        'margin-top': '0in',
        'margin-left': '0in',
        'margin-right': '0in',
        'disable-smart-shrinking': '',
    },
}

TEMPLATE_BY_FORMAT = {
    'envelope': 'envelopepdf.html',
    'avery': 'avery8163.html',
}


@app.route('/download/<format_type>/<doc_type>')
async def download(format_type: str, doc_type: str):
    if format_type not in TEMPLATE_BY_FORMAT:
        return "Format type not valid", 400
    if doc_type not in ('html', 'pdf'):
        return "Document type not valid", 400

    sender_address = session.get('sender_address')
    recipient_address = session.get('recipient_address')
    serial = session.get('serial')
    recipient_zip = session.get('recipient_zip')
    if not sender_address or not recipient_address or serial is None or not recipient_zip:
        return "Missing session data. Generate a barcode first.", 400

    human_readable_bar = generate_human_readable(recipient_zip, serial)
    row = max(1, request.args.get('row', default=1, type=int))
    col = max(1, request.args.get('col', default=1, type=int))
    barcode = imb.encode(config.BARCODE_ID, config.SRV_TYPE,
                         config.MAILER_ID, serial, str(recipient_zip))

    html = await render_template(
        TEMPLATE_BY_FORMAT[format_type],
        sender_address=sender_address,
        recipient_address=recipient_address,
        human_readable_bar=human_readable_bar,
        barcode=barcode,
        row=row,
        col=col,
    )

    if doc_type == 'html':
        return html

    pdf = await asyncio.to_thread(
        pdfkit.from_string, html, False, PDF_OPTIONS[format_type]
    )
    response = await make_response(pdf)
    response.headers['Content-Type'] = 'application/pdf'
    response.headers['Content-Disposition'] = (
        f'attachment; filename={format_type}_{serial:06d}_{recipient_zip}.pdf'
    )
    return response


@app.route('/tracking', methods=['GET'])
async def tracking():
    return await render_template("tracking.html")

@app.route('/trackingIMb', methods=['GET'])
async def trackingIMb():
    return await render_template("trackingIMb.html")


async def _merge_stored_scans(tracking_data):
    try:
        data = tracking_data.get('data')
        if not data or 'imb' not in data:
            return
        stored_scans_data = await redis_client.lrange(f'imb:{data["imb"]}', 0, -1)
        if not stored_scans_data:
            return
        merged = [json.loads(s) for s in reversed(stored_scans_data)]
        data['scans'] = merged + data.get('scans', [])
    except (KeyError, ValueError, TypeError):
        pass


@app.websocket('/track-ws')
async def track_ws():
    while True:
        try:
            req = await websocket.receive_json()
            receipt_zip = str(req['receipt_zip'])
            serial = int(req['serial'])
            if not receipt_zip.isdigit() or len(receipt_zip) not in (5, 9, 11):
                raise ValueError("bad zip")
            if serial < 0 or serial >= ROLLING_WINDOW * SERIAL_MAX:
                raise ValueError("bad serial")
            barcode = _tracking_digits(serial) + receipt_zip
        except (ValueError, TypeError, KeyError):
            await websocket.send('Invalid input received on WebSocket.')
            continue
        tracking_data = await usps_api.get_piece_tracking(barcode)
        await _merge_stored_scans(tracking_data)
        await websocket.send_json(tracking_data)


@app.websocket('/trackIMb-ws')
async def trackIMb_ws():
    while True:
        try:
            req = await websocket.receive_json()
            barcode = str(req['IMbNum']).strip()
            if not barcode.isdigit() or len(barcode) not in (25, 29, 31):
                raise ValueError("IMb must be 25, 29, or 31 digits")
        except (ValueError, TypeError, KeyError):
            await websocket.send('Invalid input received on WebSocket.')
            continue
        tracking_data = await usps_api.get_piece_tracking(barcode)
        await _merge_stored_scans(tracking_data)
        await websocket.send_json(tracking_data)


@app.route('/validate_address', methods=['POST'])
async def validate_address():
    form = await request.form
    zip_raw = str(form.get('zip', '')).replace('-', '')
    zip_digits = ''.join(ch for ch in zip_raw if ch.isdigit())
    zip5 = zip_digits[:5]
    # JS client sends address1 = secondary (apt/suite), address2 = primary street.
    # The old API dict uses 'street_address' for primary and 'address2' for secondary.
    address = {
        'street_address': form.get('address2', '').strip(),
        'address2': form.get('address1', '').strip(),
        'city': form.get('city', '').strip(),
        'state': form.get('state', '').strip().upper(),
        'zip5': zip5,
    }
    if len(zip_digits) >= 9:
        address['zip4'] = zip_digits[5:9]
    if len(zip_digits) >= 11:
        address['dp'] = zip_digits[9:11]
    firmname = form.get('firmname', '').strip()
    if firmname:
        address['firmname'] = firmname
    standardized_address = await usps_api.get_USPS_standardized_address_new(address)
    if 'error' in standardized_address:
        return jsonify(standardized_address)
    standardized_address.setdefault('zip4', '')
    # Remap to the keys the JS client expects.
    standardized_address['address1'] = standardized_address.get('address2', '')
    standardized_address['address2'] = standardized_address.get('street_address', '')
    return jsonify(standardized_address)


@app.route('/usps_feed', methods=['POST'])
async def usps_feed():
    data = await request.get_json()

    if data is None or 'events' not in data:
        return "Invalid data format.", 400

    ttl_seconds = 60 * 24 * 60 * 60  # 60 days
    pipe = redis_client.pipeline()
    stored = 0
    for event in data['events']:
        if 'imb' not in event or event.get('handlingEventType') != 'L':
            continue
        reformed_event = {
            'scan_date_time': event.get('scanDatetime'),
            'scan_event_code': event.get('scanEventCode'),
            'handling_event_type': event.get('handlingEventType'),
            'mail_phase': event.get('mailPhase'),
            'machine_name': event.get('machineName'),
            'scanner_type': event.get('scannerType'),
            'scan_facility_name': event.get('scanFacilityName'),
            'scan_facility_locale_key': event.get('scanLocaleKey'),
            'scan_facility_city': event.get('scanFacilityCity'),
            'scan_facility_state': event.get('scanFacilityState'),
            'scan_facility_zip': event.get('scanFacilityZip'),
        }
        redis_key = f'imb:{event["imb"]}'
        pipe.rpush(redis_key, json.dumps(reformed_event))
        pipe.expire(redis_key, ttl_seconds)
        stored += 1
    if stored:
        await pipe.execute()
    return jsonify({"stored": stored})
