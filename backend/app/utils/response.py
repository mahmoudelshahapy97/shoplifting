# app/utils/response.py
from typing import Any, Dict, Optional


def create_response(
    success: bool, message: str, data: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Helper function to create consistent response format"""
    response_dict: Dict[str, Any] = {
        "success": success,
        "message": message,
    }
    if data is not None:
        response_dict["data"] = data
    return response_dict
