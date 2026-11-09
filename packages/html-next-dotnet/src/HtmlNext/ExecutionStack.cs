using System.Runtime.CompilerServices;

namespace HtmlNext;

internal static class ExecutionStack
{
    public static void Check(string source)
    {
        try { RuntimeHelpers.EnsureSufficientExecutionStack(); }
        catch (InsufficientExecutionStackException error)
        {
            throw new HtmlNextException("HNCS006", "Component expansion exceeded the available execution stack.", source, error);
        }
    }
}
