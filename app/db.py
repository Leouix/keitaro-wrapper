from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import get_settings

_s = get_settings()
engine = create_engine(
    _s.database_url,
    connect_args=({"check_same_thread": False} if _s.database_url.startswith("sqlite") else {}),
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
