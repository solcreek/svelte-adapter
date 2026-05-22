<script>
  let { form } = $props();
</script>

<h1>conformance:form</h1>
{#if form?.message}
  <p data-testid="form-message">{form.message}</p>
{/if}
<form method="POST">
  <input name="who" />
  <button>submit</button>
</form>
