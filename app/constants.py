"""Общие константы роутеров (фаза 3): whitelists и другие списки полей.

Каждый такой список — граница безопасности: поля, которые мы отдаём
в браузер, а не всё, что вернул Keitaro (там бывают token, postbacks,
домены). Новые whitelists добавлять здесь, а не в роутерах.
"""

# Поля кампании, разрешённые к выдаче списком в браузер.
# Всё остальное (token, postbacks, domain, ...) из ответа Keitaro вырезается:
# в живом списке у каждой кампании есть token, отдавать его нельзя.
CAMPAIGN_LIST_FIELDS = ("id", "name", "alias", "state", "group", "updated_at")


def equal_shares(count: int) -> list[int]:
    """Равные целые доли, сумма ровно 100.

    Правило одно для всех мест, где делим офферы поровну (создание потока
    Offers в creator.py, reshare в streams.py): base, rest = divmod(100, n),
    первые rest получают base+1. 1 → [100], 2 → [50, 50], 3 → [34, 33, 33].
    """
    base, rest = divmod(100, count)
    return [base + (1 if i < rest else 0) for i in range(count)]
