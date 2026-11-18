"""Тесты «зафиксированного веса» (пина) офера в потоке: PUT .../pins,
GET .../pending (pins), пересчёт весов reshare при пинах и правило 6
(409 «свободного веса нет»).

Все запросы идут в httpx.MockTransport — в живой Keitaro тесты не ходят;
БД — in-memory SQLite (make_app_client). Каркас StreamsHandler,
PendingHandler, seed/read (pending, state) переиспользуются из
test_stream_offer_add / test_stream_pending / test_stream_offer_delete.
"""

import pytest

from app.keybox import KeyStore, get_key_store
from app.main import app
from app.models import StreamOfferPin
from app.deps import get_keitaro_with_key

from tests.conftest import make_app_client, make_keitaro
from tests.test_stream_offer_add import CAMPAIGN_ID, StreamsHandler
from tests.test_stream_pending import (
    OTHER_CAMPAIGN_ID,
    PendingHandler,
    apply_pending,
    put_pending,
    seed_pending,
)
from tests.test_stream_offer_delete import CampaignStreamsHandler, seed_state

STREAM_ID = 1313231

# Поток с разными весами: пины и пересчёт проверяем на нестандартных долях.
PIN3 = {
    "id": STREAM_ID,
    "type": "regular",
    "name": "Flow pins",
    "campaign_id": CAMPAIGN_ID,
    "schema": "landings",
    "offers": [
        {"offer_id": 25327, "share": 50, "state": "active"},
        {"offer_id": 25329, "share": 30, "state": "paused"},
        {"offer_id": 25330, "share": 20, "state": "active"},
    ],
}

# Для «удаление всех незапаянных»: два пина 40/30 и незапаянный 30.
PIN_40_30_30 = {
    **PIN3,
    "offers": [
        {"offer_id": 25327, "share": 40, "state": "active"},
        {"offer_id": 25329, "share": 30, "state": "active"},
        {"offer_id": 25330, "share": 30, "state": "active"},
    ],
}


class PinHandler(PendingHandler):
    """StreamsHandler, знающий все оферы (для add/remove тестов)."""

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and "/admin_api/v1/offers/25330" in request.url.path:
            return httpx.Response(
                200, json={"id": 25330, "name": "Offer D", "payout": 3.0, "currency": "USD"}
            )
        return super().__call__(request)


def make_client(handler) -> tuple:
    c, Session = make_app_client(
        handler, extra_overrides={get_keitaro_with_key: lambda: make_keitaro(handler)}
    )
    return c, Session


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


def seed_pin(
    Session,
    stream_id: int,
    offer_id: int,
    share: int | None,
    *,
    campaign_id: int = CAMPAIGN_ID,
) -> None:
    db = Session()
    db.add(
        StreamOfferPin(
            campaign_id=campaign_id,
            stream_id=stream_id,
            offer_id=offer_id,
            share=share,
        )
    )
    db.commit()
    db.close()


def seed_live_state(Session, stream_id: int = STREAM_ID, ids=(25327, 25329, 25330)) -> None:
    for oid in ids:
        seed_state(Session, stream_id, oid, share=33, state="active")


def read_pins(Session, stream_id: int = STREAM_ID) -> dict[int, int | None]:
    db = Session()
    rows = (
        db.query(StreamOfferPin)
        .filter(StreamOfferPin.stream_id == stream_id)
        .order_by(StreamOfferPin.id)
        .all()
    )
    data = {r.offer_id: r.share for r in rows}
    db.close()
    return data


def put_pins(c, body, *, cid=CAMPAIGN_ID, sid=STREAM_ID):
    return c.put(f"/api/campaigns/{cid}/streams/{sid}/pins", json=body)


# --- 1. Пинов нет — прежнее поведение reshare --------------------------------


def test_no_pins_add_behaves_as_before():
    # Регрессия-ограничитель: без пинов добавление не изменилось
    # (живые веса не перетираются, новый офер получает средний вес живых).
    h = PendingHandler(PIN3)
    c, _ = make_client(h)
    put_pending(c, {"add": [25328], "remove": []})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 50, "state": "active"},
        {"offer_id": 25329, "share": 30, "state": "paused"},
        {"offer_id": 25330, "share": 20, "state": "active"},
        {"offer_id": 25328, "share": 33, "state": "active"},
    ]


# --- 2. PUT .../pins: замена набора целиком, дубли, без Keitaro ---------------


def test_put_pins_replaces_whole_set_dedup_first_wins():
    h = PendingHandler(PIN3)
    c, Session = make_client(h)

    r = put_pins(c, {"pins": [
        {"offer_id": 25327, "share": 40},
        {"offer_id": 25327, "share": 50},   # дубль — схлопывается
        {"offer_id": 25329, "share": None},  # share может быть null
    ]})
    assert r.status_code == 200
    assert [(p["offer_id"], p["share"]) for p in r.json()["pins"]] == [
        (25327, 40),
        (25329, None),
    ]
    assert read_pins(Session) == {25327: 40, 25329: None}
    assert h.put_bodies == []  # пины — только своя БД, Keitaro не дёргается

    # Повторный PUT заменяет набор целиком, а не дополняет.
    r2 = put_pins(c, {"pins": [{"offer_id": 25330, "share": 10}]})
    assert r2.status_code == 200
    assert read_pins(Session) == {25330: 10}


@pytest.mark.parametrize(
    "body",
    [
        {"pins": [{"offer_id": 0, "share": 5}]},       # offer_id <= 0
        {"pins": [{"offer_id": -1, "share": 5}]},      # offer_id <= 0
        {"pins": [{"offer_id": 25327}]},               # нет share
        {"pins": [{"offer_id": 25327, "share": -1}]},  # share < 0
        {"pins": [{"offer_id": 25327, "share": 101}]},  # share > 100
        {"pins": [{"offer_id": 25327, "share": "x"}]},  # не целое
        {"pins": [{"offer_id": 25327, "share": 5, "stream_id": 1}]},  # лишнее поле
        {"pins": "x"},                                  # не список
    ],
)
def test_put_pins_body_validation_422(body):
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 40)
    r = put_pins(c, body)
    assert r.status_code == 422
    # Некорректное тело ничего не меняет (замена происходит только целиком).
    assert read_pins(Session) == {25327: 40}


def test_pins_endpoints_work_without_api_key(tmp_path):
    # GET pending и PUT pins — только своя БД: работают без ключа Keitaro.
    h = PendingHandler(PIN3)
    c, Session = make_app_client(h)
    app.dependency_overrides.pop(get_keitaro_with_key, None)
    app.dependency_overrides[get_key_store] = lambda: KeyStore(tmp_path / "absent.key")

    r = put_pins(c, {"pins": [{"offer_id": 25327, "share": 50}]})
    assert r.status_code == 200
    assert read_pins(Session) == {25327: 50}

    r2 = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams/pending")
    assert r2.status_code == 200
    assert r2.json()["pins"] == [
        {"stream_id": STREAM_ID, "offer_id": 25327, "share": 50}
    ]


# --- 3. GET pending: пины только своей кампании -------------------------------


def test_get_pending_pins_only_own_campaign_ordered():
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25329, 30)
    seed_pin(Session, STREAM_ID, 25327, 50)
    seed_pin(Session, 777, 25328, 10, campaign_id=OTHER_CAMPAIGN_ID)

    r = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams/pending")
    assert r.status_code == 200
    pins = r.json()["pins"]
    assert [(p["stream_id"], p["offer_id"], p["share"]) for p in pins] == [
        (STREAM_ID, 25329, 30),
        (STREAM_ID, 25327, 50),
    ]
    for p in pins:
        assert set(p.keys()) == {"stream_id", "offer_id", "share"}

    r2 = c.get(f"/api/campaigns/{OTHER_CAMPAIGN_ID}/streams/pending")
    assert r2.status_code == 200
    assert [(p["stream_id"], p["offer_id"]) for p in r2.json()["pins"]] == [
        (777, 25328)
    ]


# --- 4. Добавление с пинами: пины не меняются, незапаянные делят остаток ------


def test_add_one_pin_keeps_pin_unpinned_split_remainder_first():
    # Пин A=50; добавляем D: незапаянные B, C, D делят 50 -> 17/17/16,
    # остаток от деления — первым по порядку потока (B).
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 50)
    put_pending(c, {"add": [25328], "remove": []})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 50, "state": "active"},   # пин не тронут
        {"offer_id": 25329, "share": 17, "state": "paused"},
        {"offer_id": 25330, "share": 17, "state": "active"},
        {"offer_id": 25328, "share": 16, "state": "active"},
    ]
    assert sum(o["share"] for o in h.put_bodies[0]["offers"]) == 100
    assert read_pins(Session) == {25327: 50}


def test_add_two_pins_free_20_split_between_unpinned():
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 50)
    seed_pin(Session, STREAM_ID, 25329, 30)
    put_pending(c, {"add": [25328], "remove": []})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 50, "state": "active"},
        {"offer_id": 25329, "share": 30, "state": "paused"},
        {"offer_id": 25330, "share": 10, "state": "active"},
        {"offer_id": 25328, "share": 10, "state": "active"},
    ]


def test_add_100_div_3_with_remainder_to_first_in_stream():
    # Пин A=33; незапаянные B, C, D делят 67: base=22, rest=1 -> 23/22/22.
    stream = {**PIN3, "offers": [
        {"offer_id": 25327, "share": 33, "state": "active"},
        {"offer_id": 25329, "share": 33, "state": "paused"},
        {"offer_id": 25330, "share": 33, "state": "active"},
    ]}
    h = PendingHandler(stream)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 33)
    put_pending(c, {"add": [25328], "remove": []})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 33, "state": "active"},
        {"offer_id": 25329, "share": 23, "state": "paused"},
        {"offer_id": 25330, "share": 22, "state": "active"},
        {"offer_id": 25328, "share": 22, "state": "active"},
    ]


def test_add_pinned_draft_keeps_click_weight():
    # Пин на черновике (pending add): вес 25, зафиксированный в момент
    # клика, сохраняется; незапаянные живые делят 75 -> по 25.
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    put_pending(c, {"add": [25328], "remove": []})
    seed_pin(Session, STREAM_ID, 25328, 25)

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 25, "state": "active"},
        {"offer_id": 25329, "share": 25, "state": "paused"},
        {"offer_id": 25330, "share": 25, "state": "active"},
        {"offer_id": 25328, "share": 25, "state": "active"},
    ]
    assert read_pins(Session) == {25328: 25}  # пин черновика пережил apply


def test_noop_apply_leaves_pins_untouched():
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 50)

    r = apply_pending(c)  # pending пуст -> noop
    assert r.status_code == 200
    assert r.json()["noop"] is True
    assert h.put_bodies == []
    assert read_pins(Session) == {25327: 50}


# --- 5. Правило 6: Σпинов = 100 и добавляют офер -> 409 -----------------------


def test_put_pending_all_pinned_sum_100_409_pending_intact():
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_live_state(Session)
    for oid, share in ((25327, 50), (25329, 30), (25330, 20)):
        seed_pin(Session, STREAM_ID, oid, share)

    r = put_pending(c, {"add": [25328], "remove": []})
    assert r.status_code == 409
    assert r.json()["detail"] == (
        "All offers are pinned: no free weight left. "
        "Unpin at least one offer."
    )
    assert h.put_bodies == []
    # PUT отклонён — ничего не записано (в БД только пины).
    from app.models import StreamOfferPending

    db = Session()
    assert db.query(StreamOfferPending).count() == 0
    db.close()


def test_put_pending_409_not_triggered_when_removed_pin_frees_weight():
    # Тот же набор пинов, но в этом же PUT удаляют запаянный офер A:
    # Σпинов без A = 50 -> добавить можно.
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_live_state(Session)
    for oid, share in ((25327, 50), (25329, 30), (25330, 20)):
        seed_pin(Session, STREAM_ID, oid, share)

    r = put_pending(c, {"add": [25328], "remove": [25327]})
    assert r.status_code == 200
    assert [(p["offer_id"], p["action"]) for p in r.json()["pending"]] == [
        (25328, "add"),
        (25327, "remove"),
    ]

    # apply: пин A удаляется вместе с офером, D делит свободные 50.
    r2 = apply_pending(c)
    assert r2.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25329, "share": 30, "state": "paused"},
        {"offer_id": 25330, "share": 20, "state": "active"},
        {"offer_id": 25328, "share": 50, "state": "active"},
    ]
    assert read_pins(Session) == {25329: 30, 25330: 20}


def test_put_pending_without_live_state_data_not_blocked():
    # Живого состава в stream_offer_state нет — проверку не делаем
    # (не блокируем), финальная проверка — в apply.
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    for oid, share in ((25327, 50), (25329, 30), (25330, 20)):
        seed_pin(Session, STREAM_ID, oid, share)

    r = put_pending(c, {"add": [25328], "remove": []})
    assert r.status_code == 200
    assert len(r.json()["pending"]) == 1


def test_apply_all_pinned_sum_100_409_pending_intact_no_put():
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pending(Session, STREAM_ID, 25328, "add")
    for oid, share in ((25327, 50), (25329, 30), (25330, 20)):
        seed_pin(Session, STREAM_ID, oid, share)

    r = apply_pending(c)
    assert r.status_code == 409
    assert r.json()["detail"] == (
        "All offers are pinned: no free weight left. "
        "Unpin at least one offer."
    )
    assert h.put_bodies == []
    from tests.test_stream_pending import read_pending

    assert read_pending(Session) == [(25328, "add")]


def test_sync_add_to_fully_pinned_stream_409():
    # Синхронное добавление подчиняется тому же правилу 6.
    h = StreamsHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 50)
    seed_pin(Session, STREAM_ID, 25329, 30)
    seed_pin(Session, STREAM_ID, 25330, 20)

    r = c.post(f"/api/streams/{STREAM_ID}/offers", json={"offer_id": 25328})
    assert r.status_code == 409
    assert "no free weight left" in r.json()["detail"]
    assert h.put_bodies == []


# --- 6. Удаление с пинами -----------------------------------------------------


def test_remove_unpinned_pins_untouched_unpinned_scale_to_free():
    # Пин B=30; удаляем незапаянный A: C — единственный незапаянный,
    # получает весь свободный вес 70; пин B не меняется.
    h = PinHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25329, 30)

    r = c.delete(f"/api/streams/{STREAM_ID}/offers/25327")
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25329, "share": 30, "state": "paused"},
        {"offer_id": 25330, "share": 70, "state": "active"},
    ]
    assert read_pins(Session) == {25329: 30}


def test_remove_pinned_offer_pin_deleted_others_plain_rescale():
    # Пин удаляемого офера исчезает вместе с ним; остальные незапаянные
    # масштабируются к 100, как раньше (30/20 -> 60/40).
    h = PinHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 50)

    r = c.delete(f"/api/streams/{STREAM_ID}/offers/25327")
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25329, "share": 60, "state": "paused"},
        {"offer_id": 25330, "share": 40, "state": "active"},
    ]
    assert read_pins(Session) == {}


def test_remove_all_unpinned_pins_rescaled_to_100():
    # Пины A=40, B=30; удаляем последний незапаянный C: незапаянных не
    # осталось — пины масштабируются пропорционально до 100 (40:30 -> 57/43),
    # share строк пинов обновляется из payload.
    h = PinHandler(PIN_40_30_30)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 40)
    seed_pin(Session, STREAM_ID, 25329, 30)
    put_pending(c, {"add": [], "remove": [25330]})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 57, "state": "active"},
        {"offer_id": 25329, "share": 43, "state": "active"},
    ]
    assert sum(o["share"] for o in h.put_bodies[0]["offers"]) == 100
    # Правило 2: share пинов — актуальные веса из Keitaro.
    assert read_pins(Session) == {25327: 57, 25329: 43}
    from tests.test_stream_pending import read_pending

    assert read_pending(Session) == []


def test_remove_to_single_offer_share_100_pin_updated():
    # Пин B=30; удаляем A и C — остался один офер, его вес 100,
    # строка пина обновляется из payload.
    h = PinHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25329, 30)
    put_pending(c, {"add": [], "remove": [25327, 25330]})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25329, "share": 100, "state": "paused"},
    ]
    assert read_pins(Session) == {25329: 100}


def test_apply_removes_pins_of_offers_not_in_final():
    # Пин A=10, pending remove A: после PUT пина A нет в финальном составе
    # — строка пина удаляется.
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 10)
    put_pending(c, {"add": [], "remove": [25327]})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25329, "share": 60, "state": "paused"},
        {"offer_id": 25330, "share": 40, "state": "active"},
    ]
    assert read_pins(Session) == {}


def test_apply_remove_pinned_offer_deletes_pin_unpinned_rescale():
    # Пин B=30, pending remove B: пин удаляемого офера исчезает вместе
    # с ним, незапаянные масштабируются пропорционально к 100 (50/20 -> 71/29).
    h = PinHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25329, 30)
    put_pending(c, {"add": [], "remove": [25329]})

    r = apply_pending(c)
    assert r.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 71, "state": "active"},
        {"offer_id": 25330, "share": 29, "state": "active"},
    ]
    assert read_pins(Session) == {}


# --- 7. Синхронизация «Обновить из Кейтаро»: share пина из живого ответа ------


def test_sync_updates_pin_share_from_live_answer():
    # Keitaro изменил веса (A 50 -> 40): share пина A обновляется из живого
    # ответа; пин B (B по-прежнему жив) остаётся 30.
    sync_payload = [
        {
            **PIN3,
            "offers": [
                {"offer_id": 25327, "share": 40, "state": "active"},
                {"offer_id": 25329, "share": 30, "state": "paused"},
                {"offer_id": 25330, "share": 30, "state": "active"},
            ],
        }
    ]
    h = CampaignStreamsHandler(PIN3, sync_payload)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25327, 50)
    seed_pin(Session, STREAM_ID, 25329, 30)

    r = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams")
    assert r.status_code == 200
    assert read_pins(Session) == {25327: 40, 25329: 30}


# --- 8. Отмена черновика: чистка зомби-пинов (дефект D1) -----------------------


def test_cancel_draft_pin_removed_on_put_pending_and_readd_unpinned():
    # Регрессия D1: пин черновика D=25, «Отменить» (PUT pending без D)
    # -> пары больше нет в GET pins; повторное добавление того же офера
    # идёт в Keitaro незапаянным (средний вес живых, 33).
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pending(Session, STREAM_ID, 25328, "add")
    seed_pin(Session, STREAM_ID, 25328, 25)

    r = put_pending(c, {"add": [], "remove": []})
    assert r.status_code == 200
    assert r.json()["pending"] == []

    r2 = c.get(f"/api/campaigns/{CAMPAIGN_ID}/streams/pending")
    assert r2.status_code == 200
    assert r2.json()["pins"] == []
    assert read_pins(Session) == {}

    # Повторное добавление: офер незапаянный — пина нет, вес 33.
    r3 = put_pending(c, {"add": [25328], "remove": []})
    assert r3.status_code == 200
    r4 = apply_pending(c)
    assert r4.status_code == 200
    assert h.put_bodies[0]["offers"] == [
        {"offer_id": 25327, "share": 50, "state": "active"},
        {"offer_id": 25329, "share": 30, "state": "paused"},
        {"offer_id": 25330, "share": 20, "state": "active"},
        {"offer_id": 25328, "share": 33, "state": "active"},
    ]
    assert read_pins(Session) == {}


def test_live_pin_survives_draft_cancel():
    # Отменяется черновик D — пин живого офера A при этом остаётся.
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pending(Session, STREAM_ID, 25328, "add")
    seed_pin(Session, STREAM_ID, 25328, 25)
    seed_pin(Session, STREAM_ID, 25327, 50)

    r = put_pending(c, {"add": [], "remove": []})
    assert r.status_code == 200
    assert read_pins(Session) == {25327: 50}


def test_cancel_all_pending_removes_draft_pins_keeps_live_pins():
    # Отмена всех pending (пустые add/remove): пины черновиков D и E
    # сняты, пины живых оферов не тронуты.
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pending(Session, STREAM_ID, 25328, "add")
    seed_pending(Session, STREAM_ID, 25331, "add")
    seed_pending(Session, STREAM_ID, 25329, "remove")
    for oid, share in ((25328, 25), (25331, 10), (25327, 50), (25330, 20)):
        seed_pin(Session, STREAM_ID, oid, share)

    r = put_pending(c, {"add": [], "remove": []})
    assert r.status_code == 200
    assert read_pins(Session) == {25327: 50, 25330: 20}


def test_apply_noop_leaves_no_zombie_draft_pin():
    # Пин отменённого ранее черновика D (offер не живой, в pending его
    # нет) убирается noop-apply; пин живого офера A остаётся.
    h = PendingHandler(PIN3)
    c, Session = make_client(h)
    seed_pin(Session, STREAM_ID, 25328, 25)
    seed_pin(Session, STREAM_ID, 25327, 50)

    r = apply_pending(c)
    assert r.status_code == 200
    assert r.json()["noop"] is True
    assert h.put_bodies == []
    assert read_pins(Session) == {25327: 50}


def test_apply_noop_keeps_pin_of_pending_remove_offer():
    # Пин офера в pending-remove (офера уже нет в Keitaro) noop-apply
    # сохраняет: он «в pending» — его судьбу решит реальное удаление в
    # _apply_pins_after_put будущего не-noop apply.
    h = PendingHandler({**PIN3, "offers": [
        {"offer_id": 25327, "share": 50, "state": "active"},
        {"offer_id": 25329, "share": 30, "state": "paused"},
        {"offer_id": 25330, "share": 20, "state": "active"},
    ]})
    c, Session = make_client(h)
    seed_pending(Session, STREAM_ID, 25328, "remove")  # его в Keitaro нет
    seed_pin(Session, STREAM_ID, 25328, 25)
    seed_pin(Session, STREAM_ID, 25327, 50)

    r = apply_pending(c)
    assert r.status_code == 200
    assert r.json()["noop"] is True
    assert h.put_bodies == []
    assert read_pins(Session) == {25328: 25, 25327: 50}
