require_relative 'user_service'

# @return [UserService]
def build_service
  UserService.new
end

SERVICE = build_service()
SERVICE.process
SERVICE.validate
