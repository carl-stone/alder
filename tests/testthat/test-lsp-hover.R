test_that("hover rendering preserves native Markdown structure and content", {
  markdown <- paste(c(
    '<div class="container">', "", '<div role="main">', "",
    "**mean** *{base}*", "", "### Usage", "", "```R", "mean(x, ...)", "```", "",
    "| Argument | Meaning |", "| --- | --- |",
    '| `x` | An <span class="rlang">**R**</span> object. |', "",
    "### Examples", "", "```R", "mean(1:10)", "```", "", "</div>", "</div>"
  ), collapse = "\n")
  html <- alder:::lsp_hover_html(list(kind = "markdown", value = markdown))
  doc <- xml2::read_html(html)
  expect_equal(xml2::xml_text(xml2::xml_find_all(doc, "//h3")), c("Usage", "Examples"))
  expect_equal(xml2::xml_text(xml2::xml_find_all(doc, "//pre/code")),
               c("mean(x, ...)\n", "mean(1:10)\n"))
  expect_length(xml2::xml_find_all(doc, "//table"), 1L)
  expect_match(xml2::xml_text(xml2::xml_find_first(doc, "//td[2]")), "An R object.", fixed = TRUE)
  expect_length(xml2::xml_find_all(doc, "//div[@class or @role]|//span[@class]"), 0L)
})

test_that("hover rendering handles plaintext and MarkedString arrays safely", {
  plain <- "<script>alert(1)</script> & ordinary text"
  html <- alder:::lsp_hover_html(list(kind = "plaintext", value = plain))
  doc <- xml2::read_html(html)
  expect_equal(xml2::xml_text(xml2::xml_find_first(doc, "//pre/code")), plain)
  expect_length(xml2::xml_find_all(doc, "//script"), 0L)
  content <- list("### Details", list(language = "r", value = "x < 2 && y > 1"),
                  list(kind = "plaintext", value = "**literal**"))
  doc <- xml2::read_html(alder:::lsp_hover_html(content))
  expect_equal(xml2::xml_text(xml2::xml_find_first(doc, "//h3")), "Details")
  expect_equal(xml2::xml_text(xml2::xml_find_all(doc, "//pre/code")),
               c("x < 2 && y > 1", "**literal**"))
  expect_identical(alder:::lsp_hover_html(NULL), "")
  doc <- xml2::read_html(alder:::lsp_hover_html(
    "See [sum](sum.html) and [R help](https://www.r-project.org/help.html)."))
  expect_equal(xml2::xml_attr(xml2::xml_find_all(doc, "//a"), "href"),
               "https://www.r-project.org/help.html")
  expect_equal(xml2::xml_text(xml2::xml_find_first(doc, "//span")), "sum")
})

test_that("hover rendering strips hostile nested wrappers and attributes", {
  hostile <- paste0(
    '<div onmouseover="bad()"><custom-wrap onclick="bad()" srcdoc="bad">',
    "Before <strong>safe</strong><script>bad()</script>",
    '<details open ontoggle="bad()"><em>nested</em></details> after',
    '<iframe srcdoc="bad"></iframe><svg onload="bad()"></svg>',
    '<a href="java%73cript:bad()" onclick="bad()">unsafe link</a>',
    '<a href="https://example.org/help" target="_blank">safe link</a>',
    '<img src="data:text/html,bad" onerror="bad()" alt="retained description">',
    '<table onclick="bad()"><tr><td style="color:red">cell</td></tr></table>',
    "</custom-wrap></div>"
  )
  doc <- xml2::read_html(alder:::lsp_hover_html(hostile))
  expect_length(xml2::xml_find_all(doc,
    "//script|//iframe|//svg|//custom-wrap|//details"), 0L)
  expect_length(xml2::xml_find_all(doc,
    "//*[@onclick or @onmouseover or @onerror or @ontoggle or @srcdoc or @style or @open or @target]"), 0L)
  expect_equal(xml2::xml_attr(xml2::xml_find_all(doc, "//a"), "href"),
               c(NA_character_, "https://example.org/help"))
  expect_true(is.na(xml2::xml_attr(xml2::xml_find_first(doc, "//img"), "src")))
  expect_equal(xml2::xml_attr(xml2::xml_find_first(doc, "//img"), "alt"),
               "retained description")
  expect_match(xml2::xml_text(xml2::xml_find_first(doc, "//body")),
               "Before safenested after", fixed = TRUE)
  expect_equal(xml2::xml_text(xml2::xml_find_first(doc, "//td")), "cell")
  expect_equal(xml2::xml_text(xml2::xml_find_first(doc, "//em")), "nested")
})
