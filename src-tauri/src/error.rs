use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("path is outside the vault: {0}")]
    OutsideVault(String),
    #[error("mq: {0}")]
    Mq(String),
    #[error("session not found: {0}")]
    SessionNotFound(String),
    #[error("{0}")]
    Other(String),
}

/// Commands return the error message to the frontend as a plain string.
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
