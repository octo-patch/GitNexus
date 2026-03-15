require_relative 'models'

def process_user
  user = get_user('alice')
  user.save
end
