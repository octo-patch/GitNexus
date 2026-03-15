using Models;

namespace Services;

public class App
{
    public void Run()
    {
        var svc = new UserService();
        var user = svc.GetUser("alice");
        user.Save();
    }
}
